// twelvedata.js - Shared TwelveData API client with DYNAMIC key rotation
const https = require('https');

const MIN_KEY_INDEX = 11;

function loadKeysFromEnv() {
  const pattern = /^TWELVE_DATA_KEY_(\d+)$/;
  const found = [];

  for (const envName of Object.keys(process.env)) {
    const match = envName.match(pattern);
    if (!match) continue;

    const index = parseInt(match[1], 10);
    if (index < MIN_KEY_INDEX) continue;

    const value = process.env[envName];
    if (value && value.trim()) {
      found.push({ index, key: value.trim(), envName });
    }
  }

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
  return KEYS[cursor % KEYS.length];
}

function peekActiveKey() {
  if (KEYS.length === 0) return null;
  const now = Date.now();
  for (let i = 0; i < KEYS.length; i++) {
    const idx = (cursor + i) % KEYS.length;
    const key = KEYS[idx];
    const cd = cooldownUntil.get(key) || 0;
    if (cd <= now) return key;
  }
  return KEYS[cursor % KEYS.length];
}

function getKeyEnvIndex(key) {
  const found = loadedKeys.find(k => k.key === key);
  return found ? found.index : null;
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
          continue;
        }
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

async function getApiUsage(key) {
  return fetchJSON(`https://api.twelvedata.com/api_usage?apikey=${key}`);
}

async function getActiveKeyStatus() {
  const key = peekActiveKey();
  if (!key) return { envIndex: null, currentUsage: null, planLimit: null, error: 'কোনো key লোড হয়নি' };
  const envIndex = getKeyEnvIndex(key);
  try {
    const data = await getApiUsage(key);
    const currentUsage = data && typeof data.current_usage === 'number' ? data.current_usage : null;
    const planLimit = data && typeof data.plan_limit === 'number' ? data.plan_limit : null;
    return { envIndex, currentUsage, planLimit, error: null };
  } catch (e) {
    return { envIndex, currentUsage: null, planLimit: null, error: e.message };
  }
}

function getKeyRange() {
  if (loadedKeys.length === 0) return { min: null, max: null, count: 0 };
  return { min: loadedKeys[0].index, max: loadedKeys[loadedKeys.length - 1].index, count: loadedKeys.length };
}

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

// ✅ নতুন — প্রতিটা key আলাদা করে (envIndex, active কিনা, cooldown-এ আছে কিনা,
// current usage/limit, exhausted কিনা) — /xadmin এর TwelveData প্যানেলের জন্য
async function getAllKeysDetailedStatus() {
  const activeKey = peekActiveKey();
  const results = [];
  for (const entry of loadedKeys) {
    const key = entry.key;
    const cd = cooldownUntil.get(key) || 0;
    const isCoolingDown = cd > Date.now();
    let currentUsage = null, planLimit = null, error = null;
    try {
      const data = await getApiUsage(key);
      currentUsage = data && typeof data.current_usage === 'number' ? data.current_usage : null;
      planLimit = data && typeof data.plan_limit === 'number' ? data.plan_limit : null;
    } catch (e) {
      error = e.message;
    }
    const isExhausted = isCoolingDown || (currentUsage !== null && planLimit !== null && currentUsage >= planLimit);
    results.push({
      envIndex: entry.index,
      isActive: key === activeKey,
      isCoolingDown,
      currentUsage,
      planLimit,
      isExhausted,
      error
    });
  }
  return results;
}

module.exports = {
  getTimeSeries, getPrice, getApiUsage, getAllKeysUsage,
  getActiveKeyStatus, getKeyRange, getAllKeysDetailedStatus,
  keyCount: KEYS.length
};
