// geminikey.js - Gemini API key pool + auto rotation manager
// ✅ নতুন — একটাই GEMINI_API_KEYS Variable, কমা (,) দিয়ে আলাদা করা key
// পুরনো GEMINI_API_KEY, GEMINI_API_KEY_1...৫০ individual ফরম্যাট আর সাপোর্ট করা হচ্ছে না।

function loadKeysFromEnv() {
  const raw = process.env.GEMINI_API_KEYS || '';
  return raw.split(',').map(k => k.trim()).filter(Boolean);
}

const GEMINI_API_KEYS = loadKeysFromEnv();

if (GEMINI_API_KEYS.length === 0) {
  console.log('⚠️ GEMINI_API_KEYS পাওয়া যায়নি বা খালি! Railway Variables চেক করো।');
} else {
  console.log(`✅ Gemini key pool লোড হয়েছে: মোট ${GEMINI_API_KEYS.length}টি key`);
}

let currentIndex = 0;
const exhaustedKeys = new Map();

function getBDDateKey() {
  const now = new Date();
  const bd = new Date(now.getTime() + 6 * 60 * 60 * 1000);
  return bd.toISOString().split('T')[0];
}

function isExhausted(key) {
  return exhaustedKeys.get(key) === getBDDateKey();
}

function markExhausted(key) {
  exhaustedKeys.set(key, getBDDateKey());
  console.log('⚠️ Gemini key exhausted (quota শেষ), আজকের জন্য বাদ: ...' + key.slice(-6));
}

// ✅ নতুন — সব exhausted key ম্যানুয়ালি রিসেট করার জন্য (/xadmin থেকে)
function resetAllExhausted() {
  const count = exhaustedKeys.size;
  exhaustedKeys.clear();
  console.log(`🔄 সব Gemini exhausted key ম্যানুয়ালি রিসেট করা হলো (${count}টা)`);
  return count;
}

function getNextActiveKey(excludeKeys = []) {
  if (GEMINI_API_KEYS.length === 0) return null;

  for (let i = 0; i < GEMINI_API_KEYS.length; i++) {
    const idx = (currentIndex + i) % GEMINI_API_KEYS.length;
    const key = GEMINI_API_KEYS[idx];
    if (!isExhausted(key) && !excludeKeys.includes(key)) {
      currentIndex = (idx + 1) % GEMINI_API_KEYS.length;
      return key;
    }
  }
  return null;
}

function getAllKeys() {
  return GEMINI_API_KEYS;
}

function getStatus() {
  return GEMINI_API_KEYS.map((key, i) => ({
    index: i + 1,
    keySuffix: '...' + key.slice(-6),
    exhausted: isExhausted(key)
  }));
}

module.exports = {
  getNextActiveKey,
  markExhausted,
  isExhausted,
  resetAllExhausted,
  getAllKeys,
  getStatus,
  totalKeys: GEMINI_API_KEYS.length
};
