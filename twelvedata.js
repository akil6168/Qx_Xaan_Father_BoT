// twelvedata.js - Shared TwelveData API client with DYNAMIC key rotation
// এই ফাইল Railway env var থেকে TWELVE_DATA_KEY_11, TWELVE_DATA_KEY_12, ...
// TWELVE_DATA_KEY_N (যত ইচ্ছা তত!) — সব automatically scan করে নেয়।
// নতুন key add করতে চাইলে শুধু Railway Variables-এ TWELVE_DATA_KEY_<পরের নাম্বার>
// বসিয়ে দিলেই হবে, কোডে হাত দেওয়ার দরকার নেই।
//
// ⚠️ IMPORTANT: শুধুমাত্র _11 এবং তার পরের নাম্বারগুলো (_11, _12, _13, ...) এই
// ফাইলে ব্যবহার হয়। TWELVE_DATA_KEY_1 থেকে TWELVE_DATA_KEY_10 (এবং bare
// TWELVE_DATA_KEY) অন্য একটা ফাংশন/মডিউল ব্যবহার করে — সেগুলো ইচ্ছাকৃতভাবে
// এখানে বাদ দেওয়া হয়েছে, যাতে দুইটা সিস্টেম মিশে না যায়।

const https = require('https');

const MIN_KEY_INDEX = 11; // এর নিচের নাম্বারগুলো (1-10) স্কিপ হবে

function loadKeysFromEnv() {
  const pattern = /^TWELVE_DATA_KEY_(\d+)$/;
  const found = [];

  for (const envName of Object.keys(process.env)) {
    const match = envName.match(pattern);
    if (!match) continue;

    const index = parseInt(match[1], 10);
    if (index < MIN_KEY_INDEX) continue; // 1-10 skip — অন্য ফাংশনের জন্য সংরক্ষিত

    const value = process.env[envName];
    if (value && value.trim()) {
      found.push({ index, key: value.trim(), envName });
    }
  }

  // নাম্বার অনুযায়ী sort করা হচ্ছে যাতে rotation ধারাবাহিক (predictable) থাকে
  found.sort((a, b) => a.index - b.index);
  return found;
}

const loadedKeys = loadKeysFromEnv();
const KEYS = loadedKeys.map(k => k.key);

if (KEYS.length === 0) {
  console.warn(`⚠️ কোনো TWELVE_DATA_KEY_${MIN_KEY_INDEX}+ env var পাওয়া যায়নি! API calls fail হবে।`);
} else {
  const names = loadedKeys.map(k => k.envName).join(', ');
  console.log(`✅ TwelveData key rotation চালু — মোট ${KEYS.length}টা key লোড হয়েছে (${names})`);
}

// per-key cooldown tracking (timestamp until which a key should be skipped)
const cooldownUntil = new Map();
let cursor = 0;

function nextKey() {
  const now = Date.now();
  for (let i = 0; i < KEYS.length; i++) {
    const key = KEYS[cursor % KEYS.length];
    cursor++;
    const cd = cooldownUntil.get(key) || 0;
    if (cd <= now) return key;
  }
  // সব key cooldown এ থাকলে, প্রথমটাই দাও (retry করাই ভালো, কিছু না করার চেয়ে)
  return KEYS[cursor % KEYS.length];
}

function markRateLimited(key, seconds = 65) {
  cooldownUntil.set(key, Date.now() + seconds * 1000);
}

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

// পুরো KEYS list এ round-robin ভাবে চেষ্টা করবো, rate-limit পেলে পরের key তে যাবো
async function callWithRotation(buildUrl, maxAttempts) {
  if (KEYS.length === 0) throw new Error(`No TwelveData API key configured (need TWELVE_DATA_KEY_${MIN_KEY_INDEX} or higher)`);
  const attempts = maxAttempts || KEYS.length;
  let lastErr;

  for (let i = 0; i < attempts; i++) {
    const key = nextKey();
    const url = buildUrl(key);
    try {
      const data = await fetchJSON(url);

      if (data && data.status === 'error') {
        const msg = (data.message || '').toLowerCase();
        const isRateLimit = data.code === 429 || msg.includes('limit') || msg.includes('run out of api credits');
        if (isRateLimit) {
          markRateLimited(key);
          lastErr = new Error('Rate limited: ' + data.message);
          continue; // পরের key দিয়ে retry
        }
        // অন্য error (invalid symbol ইত্যাদি) — retry করে লাভ নেই
        throw new Error(data.message || 'TwelveData error');
      }

      return data;
    } catch (e) {
      lastErr = e;
      continue;
    }
  }
  throw lastErr || new Error('All TwelveData keys exhausted');
}

async function getTimeSeries(symbol, interval = '1min', outputsize = 30) {
  return callWithRotation(key =>
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${outputsize}&apikey=${key}`
  );
}

async function getPrice(symbol) {
  return callWithRotation(key =>
    `https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbol)}&apikey=${key}`
  );
}

// ✅ নতুন — একটা নির্দিষ্ট key-এর জন্য /api_usage থেকে current_usage ও plan_limit আনা
async function getApiUsage(key) {
  return fetchJSON(`https://api.twelvedata.com/api_usage?apikey=${key}`);
}

// ✅ নতুন — লোড হওয়া সবগুলো key-এর usage একসাথে চেক করে array রিটার্ন করে
// প্রতিটা entry: { keyTail, currentUsage, planLimit, error? }
async function getAllKeysUsage() {
  const results = [];
  for (const key of KEYS) {
    try {
      const data = await getApiUsage(key);
      const currentUsage = data && typeof data.current_usage === 'number' ? data.current_usage : null;
      const planLimit = data && typeof data.plan_limit === 'number' ? data.plan_limit : null;
      results.push({ keyTail: key.slice(-6), currentUsage, planLimit });
    } catch (e) {
      results.push({ keyTail: key.slice(-6), currentUsage: null, planLimit: null, error: e.message });
    }
  }
  return results;
}

module.exports = { getTimeSeries, getPrice, getApiUsage, getAllKeysUsage, keyCount: KEYS.length };
