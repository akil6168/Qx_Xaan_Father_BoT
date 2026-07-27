// news.js - Forex News Alert
const https = require('https');

const CHANNEL_ID = '-1002427080688';

// ✅ এখানে কমা দিয়ে যত key ইচ্ছা যোগ করতে পারবেন, Railway variable লাগবে না
const API_KEYS = [
  'lqKsBSFJTahSOuFeEFoCsyi1GZb',
  // নতুন key যোগ করতে এখানে বসান:
  // 'দ্বিতীয়_key',
  // 'তৃতীয়_key',
];

if (API_KEYS.length === 0) {
  console.warn('⚠️ API_KEYS খালি! News alert কাজ করবে না — news.js-এ key যোগ করুন।');
}

let currentKeyIndex = 0;
let newsAlertActive = false;

// ✅ প্রতি ঘণ্টায় একবার fetch করা ডেটা এখানে cache থাকবে
let cachedNewsList = [];
let lastFetchTime = 0;
const FETCH_INTERVAL_MS = 60 * 60 * 1000; // ১ ঘণ্টা

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// একটা key দিয়ে fail করলে পরের key-তে rotate করে retry করে
// সফল হলেও পরের বার call-এর জন্য পরের key-তে rotate করে (round-robin, লোড সমান ভাগ)
async function getForexNews() {
  if (API_KEYS.length === 0) throw new Error('API_KEYS খালি — news.js-এ key নেই');

  let lastError;
  for (let attempt = 0; attempt < API_KEYS.length; attempt++) {
    const key = API_KEYS[currentKeyIndex];
    currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length; // পরের call-এর জন্য rotate

    const url = `https://fcsapi.com/api-v3/forex/economy_cal?period=today&access_key=${key}`;

    try {
      const data = await fetchJSON(url);
      if (data && data.status === false) {
        throw new Error(data.msg || 'FCS API error');
      }
      if (!data.response || !Array.isArray(data.response)) return [];
      return data.response;
    } catch (e) {
      lastError = e;
      console.log(`Key fail করেছে: ${e.message}, পরের key-তে rotate করছি...`);
    }
  }
  throw lastError || new Error('সব API key fail করেছে');
}

// পুরনো callers (checkNews) যেন এখনও silently [] পায়, error না থামায়
async function getForexNewsSafe() {
  try {
    return await getForexNews();
  } catch (e) {
    console.log('News fetch error: ' + e.message);
    return [];
  }
}

function getBDTime() {
  const now = new Date();
  return new Date(now.getTime() + 6 * 60 * 60 * 1000);
}

function getImpactEmoji(impact) {
  if (!impact) return 'LOW 🟢';
  const i = impact.toLowerCase();
  if (i === 'high') return 'HIGH 🔴';
  if (i === 'medium') return 'MEDIUM 🟡';
  return 'LOW 🟢';
}

module.exports = function(bot) {
  console.log('News alert system started!');

  const alertedNews = new Set();

  // ✅ শুধু ১ ঘণ্টা পার হলে নতুন API call করবে, নাহলে cache থেকেই কাজ চালাবে
  async function ensureNewsCache() {
    const now = Date.now();

    if (cachedNewsList.length > 0 && (now - lastFetchTime) < FETCH_INTERVAL_MS) {
      return cachedNewsList;
    }

    const freshList = await getForexNewsSafe();
    if (freshList.length > 0) {
      cachedNewsList = freshList;
      lastFetchTime = now;
      console.log(`News cache আপডেট হলো: ${freshList.length}টা ইভেন্ট`);
    }
    return cachedNewsList;
  }

  async function checkNews() {
    try {
      const newsList = await ensureNewsCache();
      if (!newsList || newsList.length === 0) return;

      const now = getBDTime();

      for (const news of newsList) {
        // শুধু high impact news
        if (!news.impact || news.impact.toLowerCase() !== 'high') continue;

        const newsId = news.id || (news.title + news.date);
        if (alertedNews.has(newsId)) continue;

        // News এর time
        let newsTime;
        try {
          newsTime = new Date(news.date);
          if (isNaN(newsTime.getTime())) continue;
        } catch (e) { continue; }

        const bdNewsTime = new Date(newsTime.getTime() + 6 * 60 * 60 * 1000);
        const diffMs = bdNewsTime - now;
        const diffMin = diffMs / (60 * 1000);

        // ২৫-৩৫ মিনিট আগে alert পাঠাবে
        if (diffMin >= 25 && diffMin <= 35) {
          alertedNews.add(newsId);
          newsAlertActive = true;

          const h = String(bdNewsTime.getUTCHours()).padStart(2, '0');
          const m = String(bdNewsTime.getUTCMinutes()).padStart(2, '0');

          await bot.sendMessage(CHANNEL_ID,
            '⚠️ *HIGH IMPACT NEWS ALERT*\n' +
            '━━━━━━━━━━━━━━━━━━\n\n' +
            '🗞 *' + (news.country || 'USD') + '* — ' + (news.title || 'News') + '\n' +
            '⏰ *Time:* `' + h + ':' + m + ' (BD Time)`\n' +
            '📊 *Impact:* ' + getImpactEmoji(news.impact) + '\n\n' +
            (news.forecast ? '📈 *Forecast:* `' + news.forecast + '`\n' : '') +
            (news.previous ? '📉 *Previous:* `' + news.previous + '`\n' : '') +
            '\n⛔ *এই সময়ে trade করবেন না!*\n' +
            '💥 Market volatile থাকবে।\n' +
            '━━━━━━━━━━━━━━━━━━',
            { parse_mode: 'Markdown' }
          );

          console.log('News alert sent: ' + (news.title || 'Unknown'));

          // News শেষ হওয়ার ৩০ মিনিট পরে signal আবার চালু
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
    } catch (e) {
      console.log('News check error: ' + e.message);
    }
  }

  // প্রতি ৫ মিনিটে timing check (কিন্তু API call শুধু ঘণ্টায় একবার হবে, বাকিটা cache থেকে)
  setTimeout(() => {
    checkNews();
    setInterval(checkNews, 5 * 60 * 1000);
  }, 10000);

  return {
    isNewsActive: () => newsAlertActive,
    // ✅ /xadmin থেকে ম্যানুয়ালি টেস্ট করার জন্য, raw ফলাফল রিটার্ন করে
    testNewsAPI: async () => {
      try {
        const list = await getForexNews();
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
