// news.js - Forex News System v3 (FCS Primary + RapidAPI Auto-Fallback + Multi-Key Rotation + Smart Cache + Health Dashboard)
const https = require('https');
const fetch = require('node-fetch');

const CHANNEL_ID = '-1002427080688';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 📰 PROVIDER 1 — FCS API (Primary, 500 call/মাস ফ্রি)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function loadKeysFromEnv() {
  const keys = [];

  if (process.env.FCS_API_KEYS) {
    const parts = process.env.FCS_API_KEYS.split(',').map(k => k.trim()).filter(Boolean);
    parts.forEach((k, i) => keys.push({ index: i + 1, key: k }));
  }

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
  console.warn('⚠️ কোনো FCS_API_KEY পাওয়া যায়নি! FCS provider কাজ করবে না — Railway Variables চেক করুন।');
} else {
  console.log(`✅ FCS News key pool লোড হয়েছে: মোট ${KEYS.length}টি key`);
}

const keyStatus = new Map();
let cursor = 0;

function markKeyStatus(key, status) {
  keyStatus.set(key, { status, lastChecked: Date.now() });
}

function isKeyUsable(key) {
  const s = keyStatus.get(key);
  if (!s) return true;
  if (s.status === 'ok') return true;
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
  return KEYS[cursor % KEYS.length];
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
  const to2 = new Date(bd.getTime() + 2 * 24 * 60 * 60 * 1000);
  const to = `${to2.getUTCFullYear()}-${pad(to2.getUTCMonth() + 1)}-${pad(to2.getUTCDate())}`;
  return { from, to };
}

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
// 📰 PROVIDER 2 — RapidAPI "Trader Calendar" (Backup, 500,000 call/মাস ফ্রি)
// FCS-এর সব key exhausted/rate-limited হলে স্বয়ংক্রিয়ভাবে এখানে switch করে
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function loadRapidKeysFromEnv() {
  const keys = [];
  if (process.env.RAPIDAPI_KEYS) {
    const parts = process.env.RAPIDAPI_KEYS.split(',').map(k => k.trim()).filter(Boolean);
    parts.forEach((k, i) => keys.push({ index: i + 1, key: k }));
  }
  if (process.env.RAPIDAPI_KEY) keys.push({ index: 0, key: process.env.RAPIDAPI_KEY });
  return keys;
}

const loadedRapidKeys = loadRapidKeysFromEnv();
const RAPID_KEYS = loadedRapidKeys.map(k => k.key);
const RAPIDAPI_HOST = 'trader-calendar.p.rapidapi.com';
const RAPID_COUNTRIES = ['USA', 'EUR', 'GBR', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];

if (RAPID_KEYS.length === 0) {
  console.warn('⚠️ কোনো RAPIDAPI_KEY পাওয়া যায়নি! FCS limit শেষ হলে backup provider থাকবে না।');
} else {
  console.log(`✅ RapidAPI Backup key pool লোড হয়েছে: মোট ${RAPID_KEYS.length}টি key (500,000/মাস/key ফ্রি)`);
}

let rapidCursor = 0;
const rapidKeyStatus = new Map();

function markRapidKeyStatus(key, status) {
  rapidKeyStatus.set(key, { status, lastChecked: Date.now() });
}

function nextRapidKey() {
  if (RAPID_KEYS.length === 0) return null;
  const key = RAPID_KEYS[rapidCursor % RAPID_KEYS.length];
  rapidCursor++;
  return key;
}

function getRapidKeyEnvIndex(key) {
  const found = loadedRapidKeys.find(k => k.key === key);
  return found ? found.index : null;
}

// importance: RapidAPI docs নিশ্চিত করেনি, কিন্তু Trading Economics (একই ধরনের calendar
// convention)-এ Importance ascending scale (1=Low, 2=Medium, 3=High) ব্যবহার হয় — তাই এটাই
// রাখা হলো। ⚠️ তবে বাস্তব ডেটায় "High" অস্বাভাবিক বেশি (৭০%+) দেখা গেছে — এই provider
// হয়তো কম granular ভাবে classify করে। এটা এখনো verify করা হয়নি, admin panel-এ
// sample data দেখে প্রয়োজনে ভবিষ্যতে এই ম্যাপিং বদলানো যাবে।
function mapImportanceToImpact(importance) {
  if (importance === 3) return 'High';
  if (importance === 2) return 'Medium';
  return 'Low';
}

async function fetchRapidAPINews() {
  if (RAPID_KEYS.length === 0) throw new Error('কোনো RAPIDAPI_KEY কনফিগার করা নেই');
  const key = nextRapidKey();
  const allNews = [];
  let anySuccess = false;
  let lastErr;

  // ✅ ফিক্স #8 — RapidAPI-র POST body-তে date-range parameter সাপোর্ট করে কিনা ডকুমেন্টেশনে
  // নিশ্চিত না, তাই client-side এ filter করা হচ্ছে — FCS-এর মতোই শুধু আজ + পরের ২ দিনের
  // event রাখা হবে (আগে সব মাসের ডেটা টেনে আনছিল, cache অকারণে ভারী হয়ে যাচ্ছিল — 22,504 event!)
  const now = Date.now();
  const windowEnd = now + 3 * 24 * 60 * 60 * 1000;

  for (const country of RAPID_COUNTRIES) {
    try {
      const res = await fetch('https://' + RAPIDAPI_HOST + '/api/calendar', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-rapidapi-host': RAPIDAPI_HOST,
          'x-rapidapi-key': key
        },
        body: JSON.stringify({ country })
      });

      if (!res.ok) {
        if (res.status === 429) markRapidKeyStatus(key, 'rateLimited');
        else if (res.status === 401 || res.status === 403) markRapidKeyStatus(key, 'invalid');
        lastErr = new Error('RapidAPI HTTP ' + res.status + ' (' + country + ')');
        continue;
      }

      const data = await res.json();
      if (Array.isArray(data)) {
        anySuccess = true;
        data.forEach(ev => {
          if (!ev.start) return;
          const t = new Date(ev.start).getTime();
          if (isNaN(t) || t < now - 60 * 60 * 1000 || t > windowEnd) return; // window-এর বাইরে হলে বাদ

          allNews.push({
            id: 'rapid_' + ev.id,
            title: ev.title || ev.shortDesc || 'News Event',
            country: country === 'GBR' ? 'GBP' : country,
            date: ev.start,
            impact: mapImportanceToImpact(ev.importance),
            forecast: null,
            previous: null
          });
        });
      }
    } catch (e) {
      lastErr = e;
    }
  }

  if (!anySuccess) throw lastErr || new Error('RapidAPI থেকে কোনো ডেটা পাওয়া যায়নি');
  markRapidKeyStatus(key, 'ok');
  return { list: allNews, usedKey: key };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ✅ Smart Cache System: signal-time কখনো API call হয় না, শুধু cache পড়া হয়
// FCS ব্যর্থ হলে (সব key rate-limited/invalid) স্বয়ংক্রিয়ভাবে RapidAPI-তে fallback করে
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let cachedNewsList = [];
let cacheStats = { total: 0, high: 0, medium: 0, low: 0 };
let lastCacheUpdate = null;
let nextRefreshTime = null;
let lastFetchOk = false;
let lastFetchError = null;
let lastFetchLatencyMs = null;
let activeProvider = 'FCS';

const FETCH_INTERVAL_MS = 60 * 60 * 1000;

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
    if (body && Array.isArray(body.response) && body.response.length > 0) {
      cachedNewsList = body.response;
      cacheStats = computeStats(cachedNewsList);
      lastCacheUpdate = Date.now();
      lastFetchOk = true;
      lastFetchError = null;
      lastFetchLatencyMs = Date.now() - start;
      activeProvider = 'FCS';
      nextRefreshTime = Date.now() + FETCH_INTERVAL_MS;
      console.log(`📦 [FCS] News cache updated: ${cacheStats.total} news (🔴${cacheStats.high} 🟡${cacheStats.medium} 🟢${cacheStats.low})`);
      return;
    }
    throw new Error('FCS থেকে খালি response এসেছে');
  } catch (fcsErr) {
    console.log('⚠️ FCS ব্যর্থ, RapidAPI backup-এ যাচ্ছে:', fcsErr.message);
  }

  try {
    const { list } = await fetchRapidAPINews();
    if (list.length > 0) {
      cachedNewsList = list;
      cacheStats = computeStats(cachedNewsList);
      lastCacheUpdate = Date.now();
      lastFetchOk = true;
      lastFetchError = null;
      lastFetchLatencyMs = Date.now() - start;
      activeProvider = 'RapidAPI';
      nextRefreshTime = Date.now() + FETCH_INTERVAL_MS;
      console.log(`📦 [RapidAPI] News cache updated: ${cacheStats.total} news (🔴${cacheStats.high} 🟡${cacheStats.medium} 🟢${cacheStats.low})`);
      return;
    }
    throw new Error('RapidAPI থেকেও খালি response এসেছে');
  } catch (rapidErr) {
    lastFetchLatencyMs = Date.now() - start;
    lastFetchOk = false;
    lastFetchError = rapidErr.message;
    console.log('❌ FCS এবং RapidAPI দুটোই ব্যর্থ (পুরনো cache-ই থাকছে):', rapidErr.message);
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
  console.log('News System v3 started (FCS + RapidAPI Auto-Fallback)!');

  let newsAlertActive = false;
  const alertedNews = new Set();

  refreshCache();
  setInterval(refreshCache, FETCH_INTERVAL_MS);

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

  setInterval(() => {
    if (!cachedNewsList.length) return;
    const now = getBDTime();
    const before = cachedNewsList.length;
    cachedNewsList = cachedNewsList.filter(n => {
      const t = new Date(n.date);
      if (isNaN(t.getTime())) return true;
      const bdT = new Date(t.getTime() + 6 * 60 * 60 * 1000);
      return bdT.getTime() > now.getTime() - 60 * 60 * 1000;
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

  // ✅ ফিক্স #27 — Health Dashboard এখন dynamic: যেই provider এই মুহূর্তে active
  // (FCS বা RapidAPI), তারই নাম আর key-status ফরম্যাটে দেখাবে।
  async function getHealthDashboard() {
    const testStart = Date.now();
    let onlineStatus, providerName, keysLoadedCount, keyRangeText, activeKeyText, keyLines;

    if (activeProvider === 'RapidAPI') {
      providerName = 'RapidAPI News';
      let usedKey = null;
      try {
        const result = await fetchRapidAPINews();
        onlineStatus = '✅ Status: Online 🟢';
        usedKey = result.usedKey;
      } catch (e) {
        onlineStatus = '❌ Status: Offline 🔴 (' + e.message + ')';
      }
      keysLoadedCount = loadedRapidKeys.length;
      keyRangeText = loadedRapidKeys.length > 0 ? ` (#${loadedRapidKeys[0].index} → #${loadedRapidKeys[loadedRapidKeys.length - 1].index})` : '';
      const activeIdx = usedKey !== null ? getRapidKeyEnvIndex(usedKey) : null;
      activeKeyText = activeIdx !== null ? '#' + activeIdx + ' 🟢' : 'N/A';

      keyLines = '';
      loadedRapidKeys.forEach(entry => {
        const s = rapidKeyStatus.get(entry.key);
        let tag = '🟢', label = 'Active';
        if (s) {
          if (s.status === 'invalid') { tag = '🔴'; label = 'Invalid'; }
          else if (s.status === 'rateLimited') { tag = '🟡'; label = 'Rate Limited'; }
        }
        const activeTag = entry.key === usedKey ? ' (Active)' : '';
        keyLines += '#' + entry.index + ' → ' + label + ' ' + tag + activeTag + '\n';
      });
    } else {
      providerName = 'FCS News';
      let usedKey = null;
      try {
        const result = await callFCSWithRotation(1);
        onlineStatus = '✅ Status: Online 🟢';
        usedKey = result.usedKey;
      } catch (e) {
        onlineStatus = '❌ Status: Offline 🔴 (' + e.message + ')';
      }
      keysLoadedCount = loadedKeys.length;
      keyRangeText = loadedKeys.length > 0 ? ` (#${loadedKeys[0].index} → #${loadedKeys[loadedKeys.length - 1].index})` : '';
      const activeIdx = usedKey !== null ? getKeyEnvIndex(usedKey) : null;
      activeKeyText = activeIdx !== null ? '#' + activeIdx + ' 🟢' : 'N/A';

      keyLines = '';
      loadedKeys.forEach(entry => {
        const s = keyStatus.get(entry.key);
        let tag = '🟢', label = 'OK';
        if (s) {
          if (s.status === 'invalid') { tag = '🔴'; label = 'Invalid'; }
          else if (s.status === 'expired') { tag = '🔴'; label = 'Expired'; }
          else if (s.status === 'rateLimited') { tag = '🟡'; label = 'Rate Limited'; }
        }
        const activeTag = entry.key === usedKey ? ' (Active)' : '';
        keyLines += '#' + entry.index + ' → ' + label + ' ' + tag + activeTag + '\n';
      });
    }

    const latencyMs = Date.now() - testStart;
    const upcoming = getUpcomingHighImpact();
    const upcomingText = upcoming
      ? (upcoming.country || 'USD') + '\n' + (upcoming.title || 'N/A') + '\n' + fmtBDTime(upcoming._time)
      : 'কোনো upcoming High Impact News নেই';

    const cacheStatusLine = cachedNewsList.length > 0 ? '✅ Active' : '⚠️ খালি';
    const lastUpdateText = lastCacheUpdate ? fmtBDTime(new Date(lastCacheUpdate + 6 * 60 * 60 * 1000)) : 'N/A';
    const nextRefreshText = nextRefreshTime ? fmtBDTime(new Date(nextRefreshTime + 6 * 60 * 60 * 1000)) : 'N/A';

    return (
      '📰 *𝗡𝗲𝘄𝘀 𝗛𝗲𝗮𝗹𝘁𝗵* — ' + providerName + (activeProvider === 'RapidAPI' ? ' (Backup) 🔄' : ' (Primary)') + '\n\n' +
      onlineStatus + '\n' +
      '⚡ Response: ' + latencyMs + 'ms\n' +
      '🔑 Keys Loaded: ' + keysLoadedCount + keyRangeText + '\n' +
      '🎯 Active Key: ' + activeKeyText + '\n' +
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
  }

  return {
    isNewsActive: () => newsAlertActive,
    getHealthDashboard,
    getActiveProvider: () => activeProvider,

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
