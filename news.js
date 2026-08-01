// news.js - Forex News System v2 (Multi-Key Rotation + Smart Cache + Health Dashboard)
const https = require('https');

const CHANNEL_ID = '-1002427080688';

// ✅ নতুন — একাধিক FCS API key সাপোর্ট (round-robin), gemini/twelvedata-এর মতোই প্যাটার্ন
// Railway-তে FCS_API_KEYS=key1,key2,key3... (কমা-সেপারেটেড, একটাই Variable) অথবা
// FCS_API_KEY / FCS_API_KEY_1, FCS_API_KEY_2 ... (পুরনো ফরম্যাট, backward-compatible)
function loadKeysFromEnv() {
  const keys = [];

  // ✅ নতুন — একটাই FCS_API_KEYS Variable, ভ্যালুতে সব key কমা (,) দিয়ে আলাদা করা
  if (process.env.FCS_API_KEYS) {
    const parts = process.env.FCS_API_KEYS.split(',').map(k => k.trim()).filter(Boolean);
    parts.forEach((k, i) => keys.push({ index: i + 1, key: k }));
  }

  // পুরনো ফরম্যাট — backward compatibility-এর জন্য রাখা হলো
  if (process.env.FCS_API_KEY) keys.push({ index: 0, key: process.env.FCS_API_KEY });
  for (let i = 1; i <= 50; i++) {
    const val = process.env['FCS_API_KEY_' + i];
    if (val) keys.push({ index: i, key: val });
  }

  return keys;
}

const loadedKeys = loadKeysFromEnv();
const KEYS = loadedKeys.map(k => k.key);

if (KEYS.length === 0) {
  console.warn('⚠️ কোনো FCS_API_KEY পাওয়া যায়নি! News system কাজ করবে না — Railway Variables চেক করুন।');
} else {
  console.log(`✅ FCS News key pool লোড হয়েছে: মোট ${KEYS.length}টি key`);
}

// প্রতিটা key-এর status ট্র্যাক করা হয় — invalid/expired/rateLimited হলে skip
const keyStatus = new Map(); // key -> { status: 'ok'|'invalid'|'expired'|'rateLimited', lastChecked }
let cursor = 0;

function markKeyStatus(key, status) {
  keyStatus.set(key, { status, lastChecked: Date.now() });
}

function isKeyUsable(key) {
  const s = keyStatus.get(key);
  if (!s) return true;
  if (s.status === 'ok') return true;
  // rateLimited হলে ১ ঘন্টা পর আবার চেষ্টা করা যাবে, invalid/expired স্থায়ীভাবে skip
  if (s.status === 'rateLimited' && Date.now() - s.lastChecked > 60 * 60 * 1000) return true;
  return s.status === 'rateLimited' ? false : (s.status !== 'invalid' && s.status !== 'expired');
}

function nextKey() {
  if (KEYS.length === 0) return null;
  for (let i = 0; i < KEYS.length; i++) {
    const idx = cursor % KEYS.length;
    cursor++;
    const key = KEYS[idx];
    if (isKeyUsable(key)) return key;
  }
  return KEYS[cursor % KEYS.length]; // সব বাদ পড়লেও একটা দিয়ে চেষ্টা
}

function getKeyEnvIndex(key) {
  const found = loadedKeys.find(k => k.key === key);
  return found ? found.index : null;
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function todayRange() {
  const now = new Date();
  const bd = new Date(now.getTime() + 6 * 60 * 60 * 1000);
  const pad = n => String(n).padStart(2, '0');
  const from = `${bd.getUTCFullYear()}-${pad(bd.getUTCMonth() + 1)}-${pad(bd.getUTCDate())}`;
  const to2 = new Date(bd.getTime() + 2 * 24 * 60 * 60 * 1000); // আজ + পরের ২ দিন পর্যন্ত upcoming
  const to = `${to2.getUTCFullYear()}-${pad(to2.getUTCMonth() + 1)}-${pad(to2.getUTCDate())}`;
  return { from, to };
}

// ✅ ফিক্স — আগের `period=today` FCS API-তে বৈধ প্যারামিটারই না ("Wrong period
// parameter value" এরর দিচ্ছিল)। FCS-এর economy_cal endpoint date-range
// (`from`/`to`) নেয়, `period` না — এখন সেটাই ব্যবহার হচ্ছে।
async function callFCSWithRotation(maxAttempts) {
  if (KEYS.length === 0) throw new Error('কোনো FCS_API_KEY কনফিগার করা নেই');
  const { from, to } = todayRange();
  const attempts = maxAttempts || KEYS.length;
  let lastErr;

  for (let i = 0; i < attempts; i++) {
    const key = nextKey();
    if (!key) break;
    const url = `https://fcsapi.com/api-v3/forex/economy_cal?from=${from}&to=${to}&access_key=${key}`;
    try {
      const { body } = await fetchJSON(url);

      if (body && body.status === false) {
        const msg = (body.msg || '').toLowerCase();
        if (msg.includes('invalid')) { markKeyStatus(key, 'invalid'); lastErr = new Error(body.msg); continue; }
        if (msg.includes('expire')) { markKeyStatus(key, 'expired'); lastErr = new Error(body.msg); continue; }
        if (msg.includes('limit') || msg.includes('quota')) { markKeyStatus(key, 'rateLimited'); lastErr = new Error(body.msg); continue; }
        // অন্য error — key ঠিক কিন্তু request-এ সমস্যা, retry করে লাভ নেই
        throw new Error(body.msg || 'FCS API error');
      }

      markKeyStatus(key, 'ok');
      return { body, usedKey: key };
    } catch (e) {
      lastErr = e;
      continue;
    }
  }
  throw lastErr || new Error('সব FCS key ব্যর্থ হয়েছে');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ✅ নতুন — Smart Cache System: signal-time কখনো API call হয় না, শুধু cache পড়া হয়
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let cachedNewsList = [];
let cacheStats = { total: 0, high: 0, medium: 0, low: 0 };
let lastCacheUpdate = null;
let nextRefreshTime = null;
let lastFetchOk = false;
let lastFetchError = null;
let lastFetchLatencyMs = null;

const FETCH_INTERVAL_MS = 10 * 60 * 1000;

function computeStats(list) {
  const stats = { total: list.length, high: 0, medium: 0, low: 0 };
  list.forEach(n => {
    const imp = (n.impact || '').toLowerCase();
    if (imp === 'high') stats.high++;
    else if (imp === 'medium') stats.medium++;
    else stats.low++;
  });
  return stats;
}

async function refreshCache() {
  const start = Date.now();
  try {
    const { body } = await callFCSWithRotation();
    lastFetchLatencyMs = Date.now() - start;
    if (body && Array.isArray(body.response)) {
      // ✅ Cache Protection — নতুন ডেটা খালি এলেও পুরনো cache রাখা হয় না override,
      // শুধু সত্যিকারের সফল non-empty response এলে replace হয় (fail-safe)
      cachedNewsList = body.response;
      cacheStats = computeStats(cachedNewsList);
      lastCacheUpdate = Date.now();
      lastFetchOk = true;
      lastFetchError = null;
      console.log(`📦 News cache updated: ${cacheStats.total} news (🔴${cacheStats.high} 🟡${cacheStats.medium} 🟢${cacheStats.low})`);
    }
  } catch (e) {
    lastFetchLatencyMs = Date.now() - start;
    lastFetchOk = false;
    lastFetchError = e.message;
    console.log('⚠️ News cache refresh ব্যর্থ (পুরনো cache-ই থাকছে): ' + e.message);
  }
  nextRefreshTime = Date.now() + FETCH_INTERVAL_MS;
}

function getBDTime() {
  const now = new Date();
  return new Date(now.getTime() + 6 * 60 * 60 * 1000);
}

function fmtBDTime(d) {
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return h + ':' + m;
}

function getImpactEmoji(impact) {
  if (!impact) return 'LOW 🟢';
  const i = impact.toLowerCase();
  if (i === 'high') return 'HIGH 🔴';
  if (i === 'medium') return 'MEDIUM 🟡';
  return 'LOW 🟢';
}

module.exports = function(bot) {
  console.log('News System v2 started!');

  let newsAlertActive = false;
  const alertedNews = new Set(); // ✅ Duplicate Protection

  // Startup — সাথে সাথে একবার fetch, তারপর প্রতি ১০ মিনিটে background refresh
  refreshCache();
  setInterval(refreshCache, FETCH_INTERVAL_MS);

  // ✅ Signal System — এখানে cache থেকেই চেক হয়, কোনো API call হয় না
  async function checkAlerts() {
    if (!cachedNewsList || cachedNewsList.length === 0) return;

    const now = getBDTime();

    for (const news of cachedNewsList) {
      if (!news.impact || news.impact.toLowerCase() !== 'high') continue;

      const newsId = news.id || (news.title + news.date);
      if (alertedNews.has(newsId)) continue;

      let newsTime;
      try {
        newsTime = new Date(news.date);
        if (isNaN(newsTime.getTime())) continue;
      } catch (e) { continue; }

      const bdNewsTime = new Date(newsTime.getTime() + 6 * 60 * 60 * 1000);
      const diffMs = bdNewsTime - now;
      const diffMin = diffMs / (60 * 1000);

      if (diffMin >= 25 && diffMin <= 35) {
        alertedNews.add(newsId);
        newsAlertActive = true;

        await bot.sendMessage(CHANNEL_ID,
          '⚠️ *HIGH IMPACT NEWS ALERT*\n' +
          '━━━━━━━━━━━━━━━━━━\n\n' +
          '🗞 *' + (news.country || 'USD') + '* — ' + (news.title || 'News') + '\n' +
          '⏰ *Time:* `' + fmtBDTime(bdNewsTime) + ' (BD Time)`\n' +
          '📊 *Impact:* ' + getImpactEmoji(news.impact) + '\n\n' +
          (news.forecast ? '📈 *Forecast:* `' + news.forecast + '`\n' : '') +
          (news.previous ? '📉 *Previous:* `' + news.previous + '`\n' : '') +
          '\n⛔ *এই সময়ে trade করবেন না!*\n' +
          '💥 Market volatile থাকবে।\n' +
          '━━━━━━━━━━━━━━━━━━',
          { parse_mode: 'Markdown' }
        );

        console.log('News alert sent: ' + (news.title || 'Unknown'));

        const waitMs = diffMs + (30 * 60 * 1000);
        setTimeout(async () => {
          newsAlertActive = false;
          try {
            await bot.sendMessage(CHANNEL_ID,
              '✅ *News শেষ হয়েছে!*\n\n' +
              '📊 𝗤𝘅 𝗔𝗜 𝗣𝗿𝗲𝗱𝗶𝗰𝘁𝗼𝗿 𝗩𝗜𝗣 𝗯𝗼𝘁 আবার signal দিচ্ছে।',
              { parse_mode: 'Markdown' }
            );
          } catch (e) {}
          console.log('Signal resumed after news.');
        }, waitMs);
      }
    }
  }

  setTimeout(() => {
    checkAlerts();
    setInterval(checkAlerts, 5 * 60 * 1000);
  }, 10000);

  // ✅ Auto Cleanup — expired news cache থেকে বাদ (শুধু upcoming relevant থাকবে)
  setInterval(() => {
    if (!cachedNewsList.length) return;
    const now = getBDTime();
    const before = cachedNewsList.length;
    cachedNewsList = cachedNewsList.filter(n => {
      const t = new Date(n.date);
      if (isNaN(t.getTime())) return true;
      const bdT = new Date(t.getTime() + 6 * 60 * 60 * 1000);
      return bdT.getTime() > now.getTime() - 60 * 60 * 1000; // ১ ঘন্টা আগে পর্যন্ত রাখা হয়
    });
    if (cachedNewsList.length !== before) {
      cacheStats = computeStats(cachedNewsList);
    }
  }, 15 * 60 * 1000);

  function getUpcomingHighImpact() {
    const now = getBDTime();
    const upcoming = cachedNewsList
      .filter(n => n.impact && n.impact.toLowerCase() === 'high')
      .map(n => {
        const t = new Date(n.date);
        return { ...n, _time: isNaN(t.getTime()) ? null : new Date(t.getTime() + 6 * 60 * 60 * 1000) };
      })
      .filter(n => n._time && n._time.getTime() > now.getTime())
      .sort((a, b) => a._time - b._time);
    return upcoming[0] || null;
  }

  return {
    isNewsActive: () => newsAlertActive,

    // ✅ নতুন — সম্পূর্ণ Health Dashboard, /xadmin এর Test News API বাটনের জন্য
    getHealthDashboard: async function() {
      const testStart = Date.now();
      let onlineStatus = '❌ Offline';
      let usedKey = null;
      try {
        const result = await callFCSWithRotation(1);
        onlineStatus = '✅ Status: Online';
        usedKey = result.usedKey;
      } catch (e) {
        onlineStatus = '❌ Status: Offline (' + e.message + ')';
      }
      const latencyMs = Date.now() - testStart;

      const activeIndex = usedKey !== null ? getKeyEnvIndex(usedKey) : null;
      const range = loadedKeys.length > 0
        ? { min: loadedKeys[0].index, max: loadedKeys[loadedKeys.length - 1].index }
        : { min: null, max: null };

      let keyLines = '';
      loadedKeys.forEach(entry => {
        const s = keyStatus.get(entry.key);
        let tag = '🟢';
        let label = 'OK';
        if (s) {
          if (s.status === 'invalid') { tag = '🔴'; label = 'Invalid'; }
          else if (s.status === 'expired') { tag = '🔴'; label = 'Expired'; }
          else if (s.status === 'rateLimited') { tag = '🟡'; label = 'Rate Limited'; }
        }
        const activeTag = entry.key === usedKey ? ' (Active)' : '';
        keyLines += '#' + entry.index + ' → ' + label + ' ' + tag + activeTag + '\n';
      });

      const upcoming = getUpcomingHighImpact();
      const upcomingText = upcoming
        ? (upcoming.country || 'USD') + '\n' + (upcoming.title || 'N/A') + '\n' + fmtBDTime(upcoming._time)
        : 'কোনো upcoming High Impact News নেই';

      const cacheStatusLine = cachedNewsList.length > 0 ? '✅ Active' : '⚠️ খালি';
      const lastUpdateText = lastCacheUpdate ? fmtBDTime(new Date(lastCacheUpdate + 6 * 60 * 60 * 1000)) : 'N/A';
      const nextRefreshText = nextRefreshTime ? fmtBDTime(new Date(nextRefreshTime + 6 * 60 * 60 * 1000)) : 'N/A';

      return (
        '📰 *𝗙𝗖𝗦 𝗡𝗲𝘄𝘀 𝗛𝗲𝗮𝗹𝘁𝗵*\n\n' +
        onlineStatus + '\n' +
        '⚡ Response: ' + latencyMs + 'ms\n' +
        '🔑 Keys Loaded: ' + loadedKeys.length + (range.min !== null ? ' (#' + range.min + ' → #' + range.max + ')' : '') + '\n' +
        '🎯 Active Key: ' + (activeIndex !== null ? '#' + activeIndex + ' 🟢' : 'N/A') + '\n' +
        '━━━━━━━━━━━━━━\n' +
        '🔑 *Key Status*\n' + (keyLines || 'কোনো key লোড হয়নি') + '\n' +
        '━━━━━━━━━━━━━━\n' +
        '📦 *Cache Status*\n' +
        cacheStatusLine + '\n' +
        'Last Update: ' + lastUpdateText + '\n' +
        'Next Refresh: ' + nextRefreshText + '\n' +
        '━━━━━━━━━━━━━━\n' +
        '*Cached News*\n' +
        'Total: ' + cacheStats.total + '\n' +
        '🔴 High: ' + cacheStats.high + '\n' +
        '🟡 Medium: ' + cacheStats.medium + '\n' +
        '🟢 Low: ' + cacheStats.low + '\n' +
        '━━━━━━━━━━━━━━\n' +
        '*Upcoming High Impact*\n' +
        upcomingText + '\n' +
        '━━━━━━━━━━━━━━\n' +
        '🚨 Alert Status: ' + (newsAlertActive ? 'Active 🔴' : 'Inactive ✅')
      );
    },

    // পুরনো নাম রাখা হলো backward-compatibility-এর জন্য (raw test)
    testNewsAPI: async () => {
      try {
        const { body } = await callFCSWithRotation();
        const list = Array.isArray(body.response) ? body.response : [];
        const highImpactCount = list.filter(n => n.impact && n.impact.toLowerCase() === 'high').length;
        return {
          ok: true,
          totalCount: list.length,
          highImpactCount,
          sample: list.slice(0, 3).map(n => ({ title: n.title, impact: n.impact, date: n.date }))
        };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
  };
};
module.exports.getCachedList = () => cachedNewsList || [];
