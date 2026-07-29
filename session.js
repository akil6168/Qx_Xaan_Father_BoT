// session.js - v10.2 - SINGLE-MESSAGE + LAST-MOMENT VERIFICATION WORKFLOW + Pause/Stop/Emergency control — VOLUME-FIX + REDESIGNED CHART
// Step 1: Silent AI Analysis (no message sent to channel)
// Step 2: Wait until 45s before next candle open
// Step 3: Last-Moment Re-Verification (last closed candle recheck)
//         -> if direction changed / confidence dropped => CANCEL, restart analysis
// Step 4: Candle Open (Entry) -> Send ONE Final Signal Message (chart + entry + direction)
// Step 5: Candle Close -> Result Message
// Step 6: MTG or WIN

const twelveData = require('./twelvedata');
const fetch = require('node-fetch');
const learner = require('./learner');

const CHANNEL_ID = '-1002268650240';
const ADMIN_ID = 5724602667;

const STICKERS = {
  SESSION_START: 'CAACAgUAAxkBAAIJJ2pPVxYeX2jAiTapeoNVCgMzIWtVAALnIgACWHFpVlTeidVCL8I3PAQ',
  SESSION_CLOSE: 'CAACAgUAAxkBAAIJKWpPVzu4tb4onZL4742yeSF5y0oLAAIJIAACc3VpVkNdndLynxI-PAQ',
  CALL:          'CAACAgUAAxkBAAIJK2pPV1ztYYU8_R49EuK5oBmFffV8AALJIgAC5k9pVqeGo-FqhqZxPAQ',
  PUT:           'CAACAgUAAxkBAAIJLWpPV14vd8gAAWhsbmXWF7ZV1myZkwAC6h4AAsjCaFalqCdpCisveDwE',
  NEXT_ONE:      'CAACAgUAAxkBAAIJM2pPV61SI184RUwfBH6nghFXAZCYAALOIAACKY5oVv-5TOUJuFB8PAQ',
  ARE_YOU_READY: 'CAACAgUAAxkBAAIJNWpPV8EahWO7lbY1ESG3M2VuyRVHAALJIAACHXdoVqVbV76nUyGLPAQ',
  SURESHOT:      'CAACAgUAAxkBAAIJN2pPWNbKDC9YJaHXrsaf1uO1aXmoAAKCJQACS0qAVqdi7137PDZoPAQ'
};

const SESSION_PAIRS = [
  { symbol: 'EUR/USD', flag: '🇪🇺🇺🇸', priority: 1 },
  { symbol: 'GBP/USD', flag: '🇬🇧🇺🇸', priority: 2 },
  { symbol: 'USD/JPY', flag: '🇺🇸🇯🇵', priority: 3 },
  { symbol: 'EUR/GBP', flag: '🇪🇺🇬🇧', priority: 4 },
  { symbol: 'USD/CHF', flag: '🇺🇸🇨🇭', priority: 5 },
  { symbol: 'EUR/JPY', flag: '🇪🇺🇯🇵', priority: 6 },
  { symbol: 'GBP/JPY', flag: '🇬🇧🇯🇵', priority: 7 },
  { symbol: 'AUD/USD', flag: '🇦🇺🇺🇸', priority: 8 },
  // ✅ নতুন — quality bar না কমিয়ে, শুধু বেশি pair স্ক্যান করে valid setup পাওয়ার
  // সম্ভাবনা বাড়ানো হলো (frequency বাড়ানোর সৎ উপায় — accuracy compromise না করে)
  { symbol: 'USD/CAD', flag: '🇺🇸🇨🇦', priority: 9 },
  { symbol: 'EUR/NZD', flag: '🇪🇺🇳🇿', priority: 10 },
  { symbol: 'GBP/NZD', flag: '🇬🇧🇳🇿', priority: 11 },
  { symbol: 'CAD/CHF', flag: '🇨🇦🇨🇭', priority: 12 }
];

const MARKET_SESSIONS = {
  LONDON: { OPEN: 14, CLOSE: 23, PAIRS: ['EUR/USD','GBP/USD','EUR/GBP','EUR/JPY','GBP/JPY','USD/CAD','EUR/NZD','GBP/NZD','CAD/CHF'] },
  NEWYORK: { OPEN: 19, CLOSE: 4, PAIRS: ['EUR/USD','GBP/USD','USD/JPY','USD/CHF','USD/CAD','EUR/NZD','GBP/NZD','CAD/CHF'] },
  TOKYO: { OPEN: 6, CLOSE: 15, PAIRS: ['USD/JPY','EUR/JPY','GBP/JPY','AUD/USD','USD/CAD','EUR/NZD','GBP/NZD','CAD/CHF'] }
};

const SESSION_INTRO_MESSAGE =
  `🏁 **𝗤𝗫 𝗔𝗜 𝗟𝗜𝗩𝗘 𝗩𝟭𝟬.𝟬**\n\n` +
  `🚀 **𝗟𝗶𝘃𝗲 𝗧𝗿𝗮𝗱𝗶𝗻𝗴 𝗦𝗲𝘀𝘀𝗶𝗼𝗻**\n\n` +
  `🎯 **শুধুমাত্র high - accuracy Conform Setup- পেলে Signal প্রদান করা হবে।**\n\n` +
  `📌 **Signal নেওয়ার আগে অবশ্যই Channel-এর Pin Message (𝗦𝗜𝗚𝗡𝗔𝗟 𝗚𝗨𝗜𝗗𝗘𝗟𝗜𝗡𝗘) পড়ে নিবেন। সেখানে Entry Time, Signal Update, Risk Management এবং Trading Rules বিস্তারিত দেওয়া আছে।**\n\n` +
  `⚠️ **প্রতিটি ট্রেডে 𝗠𝗼𝗻𝗲𝘆 𝗠𝗮𝗻𝗮𝗴𝗲𝗺𝗲𝗻𝘁 এবং 𝗥𝗶𝘀𝗸 𝗠𝗮𝗻𝗮𝗴𝗲𝗺𝗲𝗻𝘁 অবশ্যই ফলো করবেন।**`;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 📊 PERFORMANCE TRACKER (✅ এখন শুধু in-process quick reference — persistent
// storage আর stats.json এ না, সব MongoDB-তে learner.js এর মাধ্যমে যায়)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class PerformanceTracker {
  constructor() {
    this.stats = { total: 0, wins: 0, losses: 0, winRate: 0, cancelled: 0 };
  }
  addResult(symbol, direction, isWin, isMTG = false) {
    this.stats.total++;
    if (isWin) this.stats.wins++; else this.stats.losses++;
    this.stats.winRate = (this.stats.wins / this.stats.total * 100);
  }
  addCancelled() {
    this.stats.cancelled = (this.stats.cancelled || 0) + 1;
  }
  // ✅ এখন MongoDB (learner.js) থেকে গত ৩০ দিনের real aggregate stats আনে
  async getStatsMessage() {
    return learner.getStatsMessage();
  }
}

const tracker = new PerformanceTracker();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ⏰ SESSION STATE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let sessionRunning = false;
let sessionLockTimestamp = 0;
let currentSessionId = null;
let schedulerInitialized = false;
let schedulerInterval = null;
const MAX_LOSS_STREAK = 2;
const sentSignals = new Map();
const completedSessions = new Map();
const sentReminders = new Map();
const SESSION_LOCK_TIMEOUT = 45 * 60 * 1000;
const lastResults = [];

// ✅ নতুন — Pause / Stop / Emergency control state
let sessionPaused = false;
let stopRequested = false;
let emergencyChecker = () => false; // index.js থেকে setEmergencyChecker() দিয়ে সেট হবে

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🛠️ HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function getBDTime() {
  const bd = new Date(Date.now() + 6 * 60 * 60 * 1000);
  const h = bd.getUTCHours(), m = bd.getUTCMinutes(), s = bd.getUTCSeconds();
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return {
    h, m, s,
    hStr: String(h).padStart(2,'0'),
    mStr: String(m).padStart(2,'0'),
    sStr: String(s).padStart(2,'0'),
    display: `${h12}:${String(m).padStart(2,'0')} ${period}`,
    dateKey: `${bd.getUTCFullYear()}-${String(bd.getUTCMonth()+1).padStart(2,'0')}-${String(bd.getUTCDate()).padStart(2,'0')}`,
    fullTime: `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function generateSessionKey(name) { const { dateKey, h } = getBDTime(); return `${dateKey}-${name}-${h}`; }
function generateSignalKey(symbol, dir) { const { dateKey, h, m } = getBDTime(); return `${dateKey}-${h}-${Math.floor(m/5)}-${symbol}-${dir}`; }
function generateReminderKey(type) { const { dateKey, h, m } = getBDTime(); return `${dateKey}-${type}-${h}-${m}`; }

function cleanupOldEntries() {
  const now = Date.now();
  const maxAge = 2 * 60 * 60 * 1000;
  for (const [key, ts] of sentSignals) if (now - ts > maxAge) sentSignals.delete(key);
  for (const [key, ts] of completedSessions) if (now - ts > maxAge) completedSessions.delete(key);
  for (const [key, ts] of sentReminders) if (now - ts > maxAge) sentReminders.delete(key);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🔒 SESSION LOCK
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function acquireSessionLock(name) {
  const now = Date.now();
  if (sessionRunning && sessionLockTimestamp > 0 && now - sessionLockTimestamp > SESSION_LOCK_TIMEOUT) {
    console.log('⚠️ Stale lock, releasing');
    releaseSessionLock();
  }
  if (sessionRunning) return false;
  sessionRunning = true;
  sessionLockTimestamp = now;
  currentSessionId = `${name}-${now}`;
  console.log(`🔒 Lock acquired: ${currentSessionId}`);
  return true;
}

function releaseSessionLock() {
  console.log(`🔓 Lock released: ${currentSessionId}`);
  sessionRunning = false;
  sessionLockTimestamp = 0;
  currentSessionId = null;
  sessionPaused = false;
  stopRequested = false;
}

function isSessionLocked() {
  if (!sessionRunning) return false;
  const now = Date.now();
  if (sessionLockTimestamp > 0 && now - sessionLockTimestamp > SESSION_LOCK_TIMEOUT) {
    console.log('⚠️ Stale lock detected');
    return false;
  }
  return true;
}

function getActiveSessions() {
  const { h } = getBDTime();
  const active = [];
  if (h >= MARKET_SESSIONS.LONDON.OPEN && h < MARKET_SESSIONS.LONDON.CLOSE) active.push('LONDON');
  if (h >= MARKET_SESSIONS.NEWYORK.OPEN || h < MARKET_SESSIONS.NEWYORK.CLOSE) active.push('NEWYORK');
  if (h >= MARKET_SESSIONS.TOKYO.OPEN && h < MARKET_SESSIONS.TOKYO.CLOSE) active.push('TOKYO');
  return active;
}

function shouldSkipPair(symbol) {
  const active = getActiveSessions();
  const { h } = getBDTime();
  if (h < 12 && symbol === 'AUD/USD') return true;
  if (active.includes('LONDON') && !MARKET_SESSIONS.LONDON.PAIRS.includes(symbol)) return true;
  if (active.includes('NEWYORK') && !MARKET_SESSIONS.NEWYORK.PAIRS.includes(symbol)) return true;
  if (active.includes('TOKYO') && !MARKET_SESSIONS.TOKYO.PAIRS.includes(symbol)) return true;
  return false;
}

function checkLossStreak() {
  if (lastResults.length >= 3) {
    const losses = lastResults.filter(r => r === false).length;
    if (losses >= MAX_LOSS_STREAK) {
      console.log(`⚠️ Loss streak (${losses}), pausing...`);
      return true;
    }
  }
  return false;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 📨 SAFE SENDERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function safeSendSticker(bot, fileId, retries = 1) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try { await bot.sendSticker(CHANNEL_ID, fileId); return true; } catch(e) {
      console.log(`⚠️ Sticker send failed (${attempt}): ${e.message}`);
      if (attempt < retries) await sleep(1000);
    }
  }
  return false;
}

async function safeSendMessage(bot, text, options = {}, retries = 1) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await bot.sendMessage(CHANNEL_ID, text, options);
      return result;
    } catch(e) {
      console.log(`⚠️ Message send failed (${attempt}): ${e.message}`);
      if (attempt < retries) await sleep(1000);
    }
  }
  return null;
}

async function safeSendPhoto(bot, photo, caption = '', retries = 1) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await bot.sendPhoto(CHANNEL_ID, photo, { caption, parse_mode: 'Markdown' });
      return result;
    } catch(e) {
      console.log(`⚠️ Photo send failed (${attempt}): ${e.message}`);
      if (attempt < retries) await sleep(1000);
    }
  }
  return null;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 📊 PRICE & CANDLE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function getCurrentPrice(symbol) {
  const data = await twelveData.getPrice(symbol);
  return parseFloat(data.price);
}

async function getCandles(symbol, count = 50, interval = '1min') {
  const data = await twelveData.getTimeSeries(symbol, interval, count);
  if (!data.values || !data.values.length) throw new Error('No data');
  const lastCandleTime = new Date(data.values[0].datetime + ' UTC');
  const diffMinutes = (new Date() - lastCandleTime) / (60 * 1000);
  if (diffMinutes > 5) throw new Error('Stale data');
  return data.values.map(v => ({
    open: +v.open, high: +v.high, low: +v.low, close: +v.close, volume: +v.volume || 0
  })).reverse();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 📈 CORE INDICATORS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) return 50;
  let gain = 0, loss = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    d > 0 ? gain += d : loss += Math.abs(d);
  }
  return 100 - (100 / (1 + gain / (loss || 1)));
}

function calcEMA(candles, period) {
  if (candles.length < 2) return candles[0].close;
  const k = 2 / (period + 1);
  let ema = candles[0].close;
  for (let i = 1; i < candles.length; i++) ema = candles[i].close * k + ema * (1 - k);
  return ema;
}

function calcEMASeries(candles, period) {
  const k = 2 / (period + 1);
  const series = [candles[0].close];
  for (let i = 1; i < candles.length; i++) series.push(candles[i].close * k + series[i-1] * (1 - k));
  return series;
}

function calcMACD(candles) { return calcEMA(candles, 12) - calcEMA(candles, 26); }

function calcADX(candles, period = 14) {
  if (candles.length < period + 1) return { adx: 0, plusDI: 0, minusDI: 0 };
  let plusDM = [], minusDM = [], tr = [];
  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].high - candles[i-1].high;
    const downMove = candles[i-1].low - candles[i].low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i-1].close), Math.abs(candles[i].low - candles[i-1].close)));
  }
  const sum = arr => arr.slice(-period).reduce((a,b) => a+b, 0);
  const trSum = sum(tr) || 1;
  const plusDI = 100 * (sum(plusDM) / trSum);
  const minusDI = 100 * (sum(minusDM) / trSum);
  const adx = 100 * Math.abs(plusDI - minusDI) / ((plusDI + minusDI) || 1);
  return { adx, plusDI, minusDI };
}

function calcBB(candles, period = 20) {
  const p = Math.min(period, candles.length);
  const closes = candles.slice(-p).map(c => c.close);
  const sma = closes.reduce((a,b) => a+b, 0) / p;
  const std = Math.sqrt(closes.reduce((s,c) => s + Math.pow(c - sma, 2), 0) / p);
  return { upper: sma + 2*std, lower: sma - 2*std, mid: sma };
}

function calcATR(candles, period = 14) {
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i-1].close), Math.abs(candles[i].low - candles[i-1].close)));
  }
  return trs.slice(-period).reduce((a,b) => a+b, 0) / period;
}

function calcSupertrend(candles, period = 10, multiplier = 3) {
  const atr = calcATR(candles, period);
  const last = candles[candles.length - 1];
  const hl2 = (last.high + last.low) / 2;
  const upperBand = hl2 + multiplier * atr;
  const lowerBand = hl2 - multiplier * atr;
  let dir = 'NEUTRAL';
  if (last.close > upperBand) dir = 'DOWN';
  else if (last.close < lowerBand) dir = 'UP';
  else dir = last.close > hl2 ? 'UP' : 'DOWN';
  return { dir, upperBand, lowerBand };
}

function calcVWAP(candles) {
  let cumPV = 0, cumVol = 0;
  const recent = candles.slice(-30);
  for (const c of recent) {
    const typical = (c.high + c.low + c.close) / 3;
    const vol = c.volume || 1;
    cumPV += typical * vol;
    cumVol += vol;
  }
  const vwap = cumVol > 0 ? cumPV / cumVol : recent[recent.length - 1].close;
  const last = recent[recent.length - 1].close;
  return { vwap, dir: last > vwap ? 'UP' : 'DOWN' };
}

function calcSupportResistance(candles) {
  const highs = candles.map(c => c.high), lows = candles.map(c => c.low);
  const resistance = Math.max(...highs.slice(-20));
  const support = Math.min(...lows.slice(-20));
  const last = candles[candles.length - 1].close;
  const nearResistance = Math.abs(last - resistance) / last < 0.001;
  const nearSupport = Math.abs(last - support) / last < 0.001;
  return { support, resistance, nearSupport, nearResistance };
}

function calcCandlePattern(candles) {
  const len = candles.length;
  if (len < 3) return { pattern: 'No Pattern', dir: 'NEUTRAL', str: 0 };
  const c = candles[len - 1], p = candles[len - 2];
  const body = Math.abs(c.close - c.open);
  const upWick = c.high - Math.max(c.close, c.open);
  const dnWick = Math.min(c.close, c.open) - c.low;
  const range = c.high - c.low || 0.0001;
  const bull = c.close > c.open, bear = c.close < c.open;

  if (bull && p.close < p.open && c.close > p.open && c.open < p.close) return { pattern: 'Bullish Engulfing', dir: 'UP', str: 4 };
  if (bear && p.close > p.open && c.open > p.close && c.close < p.open) return { pattern: 'Bearish Engulfing', dir: 'DOWN', str: 4 };
  if (dnWick > body * 2.5 && upWick < body * 0.5) return { pattern: 'Bullish Pin Bar', dir: 'UP', str: 3 };
  if (upWick > body * 2.5 && dnWick < body * 0.5) return { pattern: 'Bearish Pin Bar', dir: 'DOWN', str: 3 };
  if (body < range * 0.1) return { pattern: 'Doji', dir: 'NEUTRAL', str: 1 };
  return { pattern: 'No Pattern', dir: 'NEUTRAL', str: 0 };
}

function calcTrend(candles) {
  const ema20 = calcEMA(candles, 20), ema50 = calcEMA(candles, 50);
  const last = candles[candles.length - 1].close;
  let up = 0, dn = 0;
  if (ema20 > ema50) up += 2; else dn += 2;
  if (last > ema20) up += 1; else dn += 1;
  if (last > ema50) up += 1; else dn += 1;
  return { dir: up > dn ? 'UP' : 'DOWN', up, dn, isStrong: up >= 3 || dn >= 3, label: up > dn ? 'Uptrend 📈' : 'Downtrend 📉' };
}

function calcIchimoku(candles) {
  const len = candles.length;
  if (len < 52) return { trend: 'NEUTRAL', up: 0, dn: 0, label: 'Ichimoku N/A' };
  const high9 = Math.max(...candles.slice(-9).map(c => c.high));
  const low9 = Math.min(...candles.slice(-9).map(c => c.low));
  const tenkan = (high9 + low9) / 2;
  const high26 = Math.max(...candles.slice(-26).map(c => c.high));
  const low26 = Math.min(...candles.slice(-26).map(c => c.low));
  const kijun = (high26 + low26) / 2;
  const senkouA = (tenkan + kijun) / 2;
  const high52 = Math.max(...candles.slice(-52).map(c => c.high));
  const low52 = Math.min(...candles.slice(-52).map(c => c.low));
  const senkouB = (high52 + low52) / 2;
  const chikou = candles.length >= 26 ? candles[candles.length - 26].close : candles[0].close;
  const last = candles[candles.length - 1].close;
  let up = 0, dn = 0;
  if (last > senkouA && last > senkouB) up += 3; else if (last < senkouA && last < senkouB) dn += 3;
  if (tenkan > kijun) up += 2; else dn += 2;
  if (chikou > last) up += 2; else dn += 2;
  return { trend: up > dn ? 'UP' : 'DOWN', up, dn, label: up > dn ? 'Ichimoku Bullish ☀️' : 'Ichimoku Bearish 🌧️' };
}

function calcMFI(candles, period = 14) {
  if (candles.length < period + 1) return 50;
  let positiveFlow = 0, negativeFlow = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const typical = (candles[i].high + candles[i].low + candles[i].close) / 3;
    const vol = candles[i].volume || 1;
    const moneyFlow = typical * vol;
    if (i > 0) {
      const prevTypical = (candles[i-1].high + candles[i-1].low + candles[i-1].close) / 3;
      if (typical > prevTypical) positiveFlow += moneyFlow;
      else if (typical < prevTypical) negativeFlow += moneyFlow;
    }
  }
  return 100 - (100 / (1 + (positiveFlow / (negativeFlow || 1))));
}

function calcFibonacci(candles) {
  const len = Math.min(50, candles.length);
  const slice = candles.slice(-len);
  const high = Math.max(...slice.map(c => c.high));
  const low = Math.min(...slice.map(c => c.low));
  const last = candles[candles.length - 1].close;
  const diff = high - low;
  const level618 = high - diff * 0.618;
  const near618 = Math.abs(last - level618) / last < 0.001;
  const above618 = last > level618;
  return { near618, above618 };
}

function calcChaikinMF(candles, period = 21) {
  if (candles.length < period) return 0;
  let sumMF = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i];
    const range = (c.high - c.low) || 0.0001;
    const mf = ((c.close - c.low) - (c.high - c.close)) / range * (c.volume || 1);
    sumMF += mf;
  }
  const totalVol = candles.slice(-period).reduce((s, c) => s + (c.volume || 1), 0);
  return totalVol > 0 ? sumMF / totalVol : 0;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🧠 EXTENDED SMART-MONEY / STRUCTURE FILTERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function findSwingPoints(candles, lookback = 2) {
  const highs = [], lows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    let isHigh = true, isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= c.high) isHigh = false;
      if (candles[j].low <= c.low) isLow = false;
    }
    if (isHigh) highs.push({ idx: i, price: c.high });
    if (isLow) lows.push({ idx: i, price: c.low });
  }
  return { highs, lows };
}

function calcMarketStructure(candles) {
  const { highs, lows } = findSwingPoints(candles);
  if (highs.length < 2 || lows.length < 2) return { structure: 'NEUTRAL', bos: false, choch: false, dir: 'NEUTRAL' };

  const lastHigh = highs[highs.length - 1], prevHigh = highs[highs.length - 2];
  const lastLow = lows[lows.length - 1], prevLow = lows[lows.length - 2];

  const higherHighs = lastHigh.price > prevHigh.price;
  const higherLows = lastLow.price > prevLow.price;
  const lowerHighs = lastHigh.price < prevHigh.price;
  const lowerLows = lastLow.price < prevLow.price;

  let structure = 'NEUTRAL';
  if (higherHighs && higherLows) structure = 'BULLISH';
  else if (lowerHighs && lowerLows) structure = 'BEARISH';

  const last = candles[candles.length - 1].close;
  const bosUp = last > lastHigh.price;
  const bosDown = last < lastLow.price;
  const choch = (structure === 'BEARISH' && bosUp) || (structure === 'BULLISH' && bosDown);
  const dir = bosUp ? 'UP' : bosDown ? 'DOWN' : (structure === 'BULLISH' ? 'UP' : structure === 'BEARISH' ? 'DOWN' : 'NEUTRAL');

  return { structure, bos: bosUp || bosDown, choch, dir };
}

function detectLiquiditySweep(candles, lookback = 15) {
  if (candles.length < lookback + 1) return { swept: false, dir: 'NEUTRAL' };
  const recent = candles.slice(-lookback - 1, -1);
  const last = candles[candles.length - 1];
  const recentHigh = Math.max(...recent.map(c => c.high));
  const recentLow = Math.min(...recent.map(c => c.low));
  const sweptHigh = last.high > recentHigh && last.close < recentHigh;
  const sweptLow = last.low < recentLow && last.close > recentLow;
  if (sweptHigh) return { swept: true, dir: 'DOWN' };
  if (sweptLow) return { swept: true, dir: 'UP' };
  return { swept: false, dir: 'NEUTRAL' };
}

function detectFakeBreakout(candles, sr) {
  if (candles.length < 3) return { fake: false, dir: 'NEUTRAL' };
  const prev = candles[candles.length - 2], last = candles[candles.length - 1];
  const brokeResistance = prev.close > sr.resistance;
  const brokeSupport = prev.close < sr.support;
  const backInsideAfterRes = brokeResistance && last.close < sr.resistance;
  const backInsideAfterSup = brokeSupport && last.close > sr.support;
  if (backInsideAfterRes) return { fake: true, dir: 'DOWN' };
  if (backInsideAfterSup) return { fake: true, dir: 'UP' };
  return { fake: false, dir: 'NEUTRAL' };
}

// ⚠️ NOTE: TwelveData's spot-forex feed (OANDA source) usually reports volume as
// 0/undefined for real FX pairs — decentralized forex has no single official volume.
// If we don't detect that and treat "no data" as "weak volume", this filter would
// silently reject EVERY signal forever. So: if no real volume data exists, skip the
// filter entirely (treat as neutral/OK) instead of failing closed.
function calcVolumeStrength(candles) {
  const recent = candles.slice(-5), longer = candles.slice(-20);
  const hasVolumeData = longer.some(c => c.volume && c.volume > 0);
  if (!hasVolumeData) return { ratio: 1, weak: false, noData: true };

  const avgRecent = recent.reduce((s, c) => s + (c.volume || 0), 0) / recent.length;
  const avgLonger = (longer.reduce((s, c) => s + (c.volume || 0), 0) / longer.length) || 1;
  const ratio = avgRecent / avgLonger;
  return { ratio, weak: ratio < 0.7, noData: false };
}

function isSidewaysMarket(adxVal, bb, currentPrice) {
  const bbWidthPct = ((bb.upper - bb.lower) / currentPrice) * 100;
  return adxVal < 18 && bbWidthPct < 0.08;
}

async function getHigherTimeframeTrend(symbol) {
  try {
    const data = await twelveData.getTimeSeries(symbol, '5min', 30);
    if (!data.values || data.values.length < 20) return 'NEUTRAL';
    const candles = data.values.map(v => ({
      open: +v.open, high: +v.high, low: +v.low, close: +v.close, volume: +v.volume || 0
    })).reverse();
    return calcTrend(candles).dir;
  } catch (e) {
    return 'NEUTRAL';
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🔍 FULL ANALYSIS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function analyzeSymbol(symbol, relaxed = false) {
  const candles = await getCandles(symbol, 52);

  const rsi = calcRSI(candles);
  const macd = calcMACD(candles);
  const adx = calcADX(candles);
  const bb = calcBB(candles);
  const supertrend = calcSupertrend(candles);
  const vwap = calcVWAP(candles);
  const sr = calcSupportResistance(candles);
  const cp = calcCandlePattern(candles);
  const atr = calcATR(candles);
  const trend = calcTrend(candles);
  const ichimoku = calcIchimoku(candles);
  const mfi = calcMFI(candles);
  const fib = calcFibonacci(candles);
  const cmf = calcChaikinMF(candles);
  const structure = calcMarketStructure(candles);
  const sweep = detectLiquiditySweep(candles);
  const fakeBO = detectFakeBreakout(candles, sr);
  const volStrength = calcVolumeStrength(candles);

  const last = candles[candles.length - 1].close;
  const signals = [];

  // ✅ বড় ফিক্স — আগে ১৬টা indicator আলাদাভাবে ভোট দিত, যার অনেকগুলোই আসলে
  // একই জিনিস (momentum/trend) বিভিন্নভাবে মাপছিল। ফলে "৮টার মধ্যে ৫টা মিলেছে"
  // সংখ্যাটা বাস্তবে ততটা independent প্রমাণ ছিল না যতটা মনে হতো, আর কড়া
  // থ্রেশহোল্ড (ratio>=0.90, ৮ এর মধ্যে ৫) মিলিয়ে অর্জন করাটা প্রায় অসম্ভব
  // ছিল — এই কারণেই সেশন প্রায়ই ঘন্টার পর ঘন্টা কোনো signal ছাড়াই চলে যেতো।
  //
  // এখন সবগুলো indicator-কে ৫টা সত্যিকারের-আলাদা category-তে ভাগ করা হয়েছে।
  // প্রতিটা category নিজের ভেতরের sub-indicator মিলিয়ে একটামাত্র ভোট দেয় —
  // তাই একমত হওয়াটা বাস্তবসম্মতভাবে অর্জনযোগ্য, কিন্তু ভুয়া ডাবল-কাউন্টিং হয় না।

  // গ্রুপ ১ — Trend & Momentum (weight 35): EMA trend + Supertrend + MACD + Ichimoku
  let g1up = 0, g1dn = 0;
  if (trend.dir === 'UP') g1up++; else g1dn++;
  if (supertrend.dir === 'UP') g1up++; else if (supertrend.dir === 'DOWN') g1dn++;
  if (macd > 0) g1up++; else g1dn++;
  if (ichimoku.trend === 'UP') g1up++; else if (ichimoku.trend === 'DOWN') g1dn++;
  const group1Dir = g1up > g1dn ? 'UP' : g1dn > g1up ? 'DOWN' : 'NEUTRAL';
  if (group1Dir === 'UP') signals.push('Trend & Momentum: Bullish 📈');
  else if (group1Dir === 'DOWN') signals.push('Trend & Momentum: Bearish 📉');

  // গ্রুপ ২ — Oscillator/Reversal (weight 20): RSI + MFI (correlated oscillator, এক ভোট)
  let g2up = 0, g2dn = 0;
  if (rsi < 35) g2up++; else if (rsi > 65) g2dn++;
  if (mfi < 25) g2up++; else if (mfi > 75) g2dn++;
  const group2Dir = g2up > g2dn ? 'UP' : g2dn > g2up ? 'DOWN' : 'NEUTRAL';
  if (group2Dir === 'UP') signals.push(`Oscillator Oversold (RSI ${rsi.toFixed(0)}, MFI ${mfi.toFixed(0)}) ✅`);
  else if (group2Dir === 'DOWN') signals.push(`Oscillator Overbought (RSI ${rsi.toFixed(0)}, MFI ${mfi.toFixed(0)}) ⚠️`);

  // গ্রুপ ৩ — Volatility & Price Position (weight 15): Bollinger + Fibonacci 61.8 + S/R proximity
  let g3up = 0, g3dn = 0;
  if (last <= bb.lower) g3up++; else if (last >= bb.upper) g3dn++;
  if (fib.near618) { if (fib.above618) g3up++; else g3dn++; }
  if (sr.nearSupport) g3up++;
  if (sr.nearResistance) g3dn++;
  const group3Dir = g3up > g3dn ? 'UP' : g3dn > g3up ? 'DOWN' : 'NEUTRAL';
  if (group3Dir === 'UP') signals.push('At Support / Lower Band ✅');
  else if (group3Dir === 'DOWN') signals.push('At Resistance / Upper Band ⚠️');

  // গ্রুপ ৪ — Volume & Flow (weight 15): VWAP + CMF (volume ডেটা দুর্বল হলে এই গ্রুপ neutral)
  let g4up = 0, g4dn = 0;
  if (!volStrength.weak) {
    if (vwap.dir === 'UP') g4up++; else g4dn++;
    if (cmf > 0.05) g4up++; else if (cmf < -0.05) g4dn++;
  }
  const group4Dir = g4up > g4dn ? 'UP' : g4dn > g4up ? 'DOWN' : 'NEUTRAL';
  if (group4Dir === 'UP') signals.push('Volume/Flow Bullish 🟢');
  else if (group4Dir === 'DOWN') signals.push('Volume/Flow Bearish 🔴');

  // গ্রুপ ৫ — Structure / Smart Money (weight 15): BOS structure + liquidity sweep + candle pattern
  let g5up = 0, g5dn = 0;
  if (structure.dir === 'UP') g5up++; else if (structure.dir === 'DOWN') g5dn++;
  if (sweep.swept) { if (sweep.dir === 'UP') g5up++; else g5dn++; }
  if (cp.dir === 'UP') g5up++; else if (cp.dir === 'DOWN') g5dn++;
  const group5Dir = g5up > g5dn ? 'UP' : g5dn > g5up ? 'DOWN' : 'NEUTRAL';
  if (group5Dir === 'UP') signals.push(structure.bos ? 'Bullish Structure (BOS) 🧱' : cp.pattern);
  else if (group5Dir === 'DOWN') signals.push(structure.bos ? 'Bearish Structure (BOS) 🧱' : cp.pattern);
  if (structure.choch) signals.push('⚠️ CHOCH Detected');
  if (sweep.swept) signals.push(sweep.dir === 'UP' ? 'Liquidity Sweep (Sell-side) 🎯' : 'Liquidity Sweep (Buy-side) 🎯');
  if (fakeBO.fake) signals.unshift('⚠️ Fake Breakout Detected');

  const GROUPS = [
    { dir: group1Dir, weight: 35 },
    { dir: group2Dir, weight: 20 },
    { dir: group3Dir, weight: 15 },
    { dir: group4Dir, weight: 15 },
    { dir: group5Dir, weight: 15 }
  ];

  const nonNeutralDirs = GROUPS.filter(g => g.dir !== 'NEUTRAL').map(g => g.dir);
  const majorityDir = nonNeutralDirs.filter(d => d === 'UP').length >= nonNeutralDirs.filter(d => d === 'DOWN').length ? 'UP' : 'DOWN';

  let up = 0, dn = 0, groupsAgree = 0;
  for (const g of GROUPS) {
    if (g.dir === 'UP') up += g.weight;
    else if (g.dir === 'DOWN') dn += g.weight;
    if (g.dir === majorityDir) groupsAgree++;
  }

  const volatility = (atr / last) * 100;
  const total = up + dn;
  const dominant = Math.max(up, dn);
  const ratio = total > 0 ? dominant / total : 0.5;
  const direction = up >= dn ? 'UP' : 'DOWN';
  let aiScore = Math.round(ratio * 100);

  const sideways = isSidewaysMarket(adx.adx, bb, last);

  let htfTrend = 'NEUTRAL';
  if (aiScore >= 65 && !sideways) {
    htfTrend = await getHigherTimeframeTrend(symbol);
    if (htfTrend === direction) { aiScore = Math.min(100, aiScore + 3); signals.push(`HTF (5m) Aligned: ${htfTrend} ✅`); }
    else if (htfTrend !== 'NEUTRAL') { signals.push(`⚠️ HTF (5m) Conflict: ${htfTrend}`); }
  }

  let scoreLabel = '';
  if (aiScore >= 90) scoreLabel = 'VERY HIGH 🔥';
  else if (aiScore >= 80) scoreLabel = 'HIGH 🟢';
  else if (aiScore >= 70) scoreLabel = 'MEDIUM 🟡';
  else scoreLabel = 'LOW ⚠️';

  const htfAligned = htfTrend === direction || htfTrend === 'NEUTRAL';
  const volumeOk = !volStrength.weak;
  const noFakeAgainst = !(fakeBO.fake && fakeBO.dir !== direction);
  const noChochAgainst = !(structure.choch && structure.dir !== direction);
  const notSideways = !sideways;

  // ✅ ফিক্স — আগে strict মোডে ৮টার (highly correlated) মধ্যে ৫টা + ratio>=0.90
  // লাগতো যা বাস্তবে প্রায় অসম্ভব ছিল। এখন ৫টা independent category-র মধ্যে
  // ৪টা মেলা লাগবে (ratio>=0.80) — কনফার্মেশনের মান একই রকম কড়া রাখা হয়েছে,
  // কিন্তু বাস্তবে অর্জনযোগ্য যাতে সেশন খালি হাতে শেষ না হয়।
  const isValid = relaxed
    ? (ratio >= 0.65 && aiScore >= 65 && groupsAgree >= 3 && volatility >= 0.0015 && notSideways && volumeOk)
    : (ratio >= 0.80 && aiScore >= 80 && trend.isStrong && volatility >= 0.003 && adx.adx >= 18 &&
       groupsAgree >= 4 && htfAligned && notSideways && volumeOk && noFakeAgainst && noChochAgainst);

  return {
    symbol, direction, ratio, aiScore, scoreLabel, trend: trend.dir,
    signals: signals.slice(0, 10), currentPrice: last, volatility,
    isValid, sr, candles, adx: adx.adx, directionsAgree: groupsAgree,
    structure, sweep, fakeBO, volStrength, sideways, htfTrend
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ✅ LAST-MOMENT RE-VERIFICATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function reverifySignal(signal) {
  try {
    const fresh = await analyzeSymbol(signal.symbol, false);
    const sameDirection = fresh.direction === signal.direction;
    const stillStrong = fresh.aiScore >= 75 && fresh.ratio >= 0.75;
    const notSidewaysNow = !fresh.sideways;
    const noFakeAgainstNow = !(fresh.fakeBO.fake && fresh.fakeBO.dir !== signal.direction);
    const noChochAgainstNow = !(fresh.structure.choch && fresh.structure.dir !== signal.direction);

    const confirmed = sameDirection && stillStrong && notSidewaysNow && noFakeAgainstNow && noChochAgainstNow;

    return {
      confirmed,
      updatedData: confirmed ? {
        aiScore: fresh.aiScore, scoreLabel: fresh.scoreLabel, trend: fresh.direction,
        signals: fresh.signals, candles: fresh.candles, currentPrice: fresh.currentPrice, ratio: fresh.ratio
      } : {}
    };
  } catch (e) {
    console.log(`⚠️ Re-verification failed for ${signal.symbol}: ${e.message}`);
    return { confirmed: false, updatedData: {} };
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 📊 CHART GENERATION (QuickChart — TradingView-style colors)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function formatChartTime(offsetMinutesFromNow) {
  const bd = new Date(Date.now() + 6 * 60 * 60 * 1000 - offsetMinutesFromNow * 60 * 1000);
  return `${String(bd.getUTCHours()).padStart(2,'0')}:${String(bd.getUTCMinutes()).padStart(2,'0')}`;
}

async function generateCandleChart(symbol, candles, entryPrice, exitPrice, badgeType = null, subtitle = '') {
  try {
    const plotCandles = candles.slice(-30);
    const n = plotCandles.length;
    const timeLabels = plotCandles.map((_, i) => formatChartTime(n - 1 - i));

    // ✅ FIX: real trading-platform candlestick charts (Quotex/TradingView) show each
    // candle's open starting exactly where the previous candle's close ended — a
    // continuous "staircase". TwelveData's raw feed doesn't always guarantee that
    // (small bid/ask snapshot differences), which made candles look disconnected /
    // "opening from the middle". This builds a DISPLAY-ONLY copy with open snapped to
    // the previous close (high/low extended to keep the box valid). The original
    // `plotCandles`/`candles` arrays (used for indicators, S/R, and all trade-decision
    // logic) are untouched — this only affects how the candle is drawn.
    const displayCandles = plotCandles.map((c, i) => {
      if (i === 0) return { ...c };
      const snappedOpen = plotCandles[i - 1].close;
      return {
        open: snappedOpen,
        close: c.close,
        high: Math.max(c.high, snappedOpen),
        low: Math.min(c.low, snappedOpen)
      };
    });
    const ohlcData = displayCandles.map((c, i) => ({ x: i, o: c.open, h: c.high, l: c.low, c: c.close }));
    const ema7Series = calcEMASeries(plotCandles, 7);
    const ema21Series = calcEMASeries(plotCandles, 21);
    const sr = calcSupportResistance(candles);

    const rsiPoints = [];
    for (let i = 0; i < plotCandles.length; i++) {
      const sliceEnd = candles.length - plotCandles.length + i + 1;
      const slice = candles.slice(0, sliceEnd);
      rsiPoints.push(slice.length >= 15 ? calcRSI(slice) : 50);
    }
    const latestRSI = rsiPoints[rsiPoints.length - 1];

    const volumeData = plotCandles.map((c, i) => ({ x: i, y: c.volume || 0 }));
    const volumeColors = plotCandles.map(c => c.close >= c.open ? 'rgba(38,169,105,0.55)' : 'rgba(239,83,80,0.55)');

    // TradingView-style palette
    const COLOR_UP = '#26a969';
    const COLOR_DOWN = '#ef5350';
    const dirColor = badgeType === 'PUT' ? COLOR_DOWN : COLOR_UP;

    const annotations = {
      supportLine: {
        type: 'line', yMin: sr.support, yMax: sr.support, yScaleID: 'yPrice',
        borderColor: 'rgba(170,170,180,0.4)', borderWidth: 1, borderDash: [4,4]
      },
      resistanceLine: {
        type: 'line', yMin: sr.resistance, yMax: sr.resistance, yScaleID: 'yPrice',
        borderColor: 'rgba(239,83,80,0.4)', borderWidth: 1, borderDash: [4,4]
      },
      rsiUpper: {
        type: 'line', yMin: 70, yMax: 70, yScaleID: 'yRsi',
        borderColor: 'rgba(239,83,80,0.35)', borderWidth: 1, borderDash: [3,3]
      },
      rsiLower: {
        type: 'line', yMin: 30, yMax: 30, yScaleID: 'yRsi',
        borderColor: 'rgba(120,180,255,0.35)', borderWidth: 1, borderDash: [3,3]
      },
      rsiValue: {
        type: 'label', xValue: n - 1, yValue: latestRSI, yScaleID: 'yRsi', xAdjust: 24,
        content: [`${Math.round(latestRSI)}`], color: '#b568f2', font: { size: 10, weight: 'bold' },
        backgroundColor: 'transparent', borderWidth: 0
      }
    };

    if (entryPrice) {
      annotations.entryLine = {
        type: 'line', yMin: entryPrice, yMax: entryPrice, yScaleID: 'yPrice',
        borderColor: 'rgba(255,255,255,0.85)', borderWidth: 1.3, borderDash: [6, 3],
        label: { content: `ENTRY ${entryPrice.toFixed(5)}`, enabled: true, position: 'start', backgroundColor: 'transparent', color: '#fff', font: { size: 10 } }
      };
    }

    if (exitPrice && entryPrice) {
      const isWin = exitPrice > entryPrice;
      annotations.exitLine = {
        type: 'line', yMin: exitPrice, yMax: exitPrice, yScaleID: 'yPrice',
        borderColor: isWin ? COLOR_UP : COLOR_DOWN, borderWidth: 1.3, borderDash: [2, 2],
        label: { content: `CLOSE ${exitPrice.toFixed(5)}`, enabled: true, position: 'end', backgroundColor: isWin ? 'rgba(38,169,105,0.85)' : 'rgba(239,83,80,0.85)', color: '#fff', font: { size: 10, weight: 'bold' } }
      };
    }

    // Top-right pinned badge (persistent, like NoAlgo's corner tag) + arrow line down to entry
    if (badgeType) {
      const badgeLabel = badgeType === 'CALL' ? '▲ CALL' : '▼ PUT';
      const topPrice = Math.max(...plotCandles.map(c => c.high));

      annotations.cornerBadge = {
        type: 'label',
        xValue: n - 1, xAdjust: 60,
        yValue: topPrice, yAdjust: -70,
        content: [badgeLabel],
        color: dirColor,
        backgroundColor: 'rgba(13,14,26,0.9)',
        borderColor: dirColor,
        borderWidth: 1.5,
        borderRadius: 4,
        font: { size: 13, weight: 'bold' },
        padding: 8
      };

      if (entryPrice) {
        annotations.entryArrow = {
          type: 'line',
          xMin: n - 1, xMax: n - 1,
          yMin: topPrice, yMax: entryPrice,
          borderColor: dirColor, borderWidth: 1.5, borderDash: [4, 3],
          arrowHeads: { end: { enabled: true, fill: true, backgroundColor: dirColor, borderColor: dirColor, length: 8, width: 6 } }
        };
        annotations.entryBadge = {
          type: 'label',
          xValue: n - 1, xAdjust: 55,
          yValue: entryPrice, yAdjust: -14,
          content: [badgeLabel],
          color: dirColor,
          backgroundColor: 'rgba(13,14,26,0.9)',
          borderColor: dirColor,
          borderWidth: 1.3,
          borderRadius: 4,
          font: { size: 11, weight: 'bold' },
          padding: 6
        };
      }
    }

    const titleText = symbol.replace('/', '');
    const subtitleText = subtitle || `M1 • ${getBDTime().fullTime} (UTC+6) • AI Engine v10.0`;

    const chartConfig = {
      type: 'candlestick',
      data: {
        labels: timeLabels,
        datasets: [
          {
            label: symbol,
            data: ohlcData,
            color: { up: COLOR_UP, down: COLOR_DOWN, unchanged: '#888888' },
            borderColor: { up: COLOR_UP, down: COLOR_DOWN, unchanged: '#888888' },
            yAxisID: 'yPrice'
          },
          {
            type: 'line', label: 'EMA 7',
            data: ema7Series.map((v, i) => ({ x: i, y: v })),
            borderColor: '#ffaa00', borderWidth: 1.3, pointRadius: 0, fill: false, yAxisID: 'yPrice'
          },
          {
            type: 'line', label: 'EMA 21',
            data: ema21Series.map((v, i) => ({ x: i, y: v })),
            borderColor: '#2dd4f5', borderWidth: 1.3, pointRadius: 0, fill: false, yAxisID: 'yPrice'
          },
          {
            type: 'line', label: 'Resistance',
            data: [{ x: 0, y: sr.resistance }],
            borderColor: 'rgba(239,83,80,0.6)', borderDash: [4,4], pointRadius: 0, borderWidth: 1.5, yAxisID: 'yPrice'
          },
          {
            type: 'line', label: 'Support',
            data: [{ x: 0, y: sr.support }],
            borderColor: 'rgba(170,170,180,0.6)', borderDash: [4,4], pointRadius: 0, borderWidth: 1.5, yAxisID: 'yPrice'
          },
          {
            type: 'bar', label: 'VOL',
            data: volumeData,
            backgroundColor: volumeColors,
            yAxisID: 'yVol'
          },
          {
            type: 'line', label: 'RSI (14)',
            data: rsiPoints.map((v, i) => ({ x: i, y: v })),
            borderColor: '#b568f2', backgroundColor: 'rgba(181,104,242,0.06)',
            borderWidth: 1.3, pointRadius: 0, fill: true, tension: 0.15,
            yAxisID: 'yRsi'
          }
        ]
      },
      options: {
        layout: { padding: { top: 75, right: 80, left: 5, bottom: 5 } },
        plugins: {
          title: {
            display: true, text: titleText, color: '#e8e9ed',
            font: { size: 22, weight: 'bold' }, align: 'start', padding: { bottom: 2 }
          },
          subtitle: {
            display: true, text: subtitleText, color: '#787b86',
            font: { size: 11 }, align: 'start', padding: { bottom: 12 }
          },
          legend: {
            display: true, position: 'top', align: 'start',
            labels: {
              color: '#9aa0a8', font: { size: 10 }, boxWidth: 14,
              filter: (item) => item.text !== symbol && item.text !== 'VOL'
            }
          },
          annotation: { annotations }
        },
        scales: {
          x: {
            type: 'category',
            ticks: { color: '#787b86', maxRotation: 0, autoSkip: true, maxTicksLimit: 8, font: { size: 9 } },
            grid: { color: 'rgba(255,255,255,0.04)' }
          },
          yPrice: {
            position: 'right',
            stack: 'panels', stackWeight: 5,
            ticks: { color: '#d1d4dc', font: { size: 10 } },
            grid: { color: 'rgba(255,255,255,0.06)' }
          },
          yVol: {
            position: 'right',
            stack: 'panels', stackWeight: 1,
            ticks: { display: false },
            grid: { display: false }
          },
          yRsi: {
            position: 'right',
            stack: 'panels', stackWeight: 1.5,
            min: 0, max: 100,
            ticks: { color: '#787b86', font: { size: 9 }, stepSize: 30 },
            grid: { color: 'rgba(255,255,255,0.04)' }
          }
        }
      }
    };

    const response = await fetch('https://quickchart.io/chart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chart: chartConfig,
        width: 1100,
        height: 750,
        backgroundColor: '#0d0e1a', // TradingView-style near-black background
        version: '3'
      })
    });

    if (!response.ok) throw new Error(`QuickChart error: ${response.status}`);
    return await response.buffer();
  } catch (error) {
    console.error('❌ Chart generation failed:', error.message);
    return null;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🔍 BEST PAIR FINDER (fully silent — no messages sent)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function findBestPair(ignoreTime = false, relaxed = false) {
  if (!ignoreTime && checkLossStreak()) {
    console.log('⏸️ Loss streak detected, pausing...');
    return null;
  }

  let best = null;
  const activeSessions = getActiveSessions();
  console.log(`📊 Active Sessions: ${activeSessions.join(', ') || 'None'}${relaxed ? ' | ⚡ RELAXED MODE' : ''}`);

  for (const pair of SESSION_PAIRS) {
    try {
      if (!ignoreTime && shouldSkipPair(pair.symbol)) {
        console.log(`⏭️ Skipping ${pair.symbol} - Not suitable`);
        continue;
      }
      const result = await analyzeSymbol(pair.symbol, relaxed);
      result.flag = pair.flag;
      result.priority = pair.priority;
      console.log(`📊 ${pair.symbol}: Score=${result.aiScore}% | Valid=${result.isValid} | ADX=${result.adx.toFixed(0)} | Agree=${result.directionsAgree}/5 | Sideways=${result.sideways} | HTF=${result.htfTrend}`);

      if (!result.isValid) { await sleep(800); continue; }

      const priorityBonus = Math.max(0, (6 - pair.priority) * 0.5);
      const finalScore = result.aiScore + priorityBonus;

      if (!best || finalScore > (best.aiScore + Math.max(0, (6 - best.priority) * 0.5))) {
        best = result;
        best.finalScore = finalScore;
      }
      await sleep(800);
    } catch (e) {
      console.log(`❌ ${pair.symbol}: ${e.message}`);
      await sleep(500);
    }
  }
  return best;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ⏰ TIMING FUNCTIONS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function waitForVerificationTime() {
  return new Promise(resolve => {
    const check = setInterval(() => {
      const now = new Date(Date.now() + 6 * 60 * 60 * 1000);
      const s = now.getUTCSeconds();
      if (s >= 15 && s <= 20) { clearInterval(check); resolve(); }
    }, 200);
    setTimeout(() => { clearInterval(check); resolve(); }, 65000);
  });
}

function waitForCandleOpen() {
  return new Promise(resolve => {
    const check = setInterval(() => {
      const now = new Date(Date.now() + 6 * 60 * 60 * 1000);
      const s = now.getUTCSeconds();
      if (s <= 1) { clearInterval(check); resolve(); }
    }, 200);
    setTimeout(() => { clearInterval(check); resolve(); }, 65000);
  });
}

function waitForCandleClose() {
  return new Promise(resolve => {
    const check = setInterval(() => {
      const now = new Date(Date.now() + 6 * 60 * 60 * 1000);
      const s = now.getUTCSeconds();
      if (s >= 58) { clearInterval(check); resolve(); }
    }, 200);
    setTimeout(() => { clearInterval(check); resolve(); }, 65000);
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🎯 MESSAGE BUILDERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function buildFinalSignalCaption(signal, flag, entryPrice, entryTimeStr, badgeType) {
  const dirLabel = badgeType === 'CALL' ? '📈 𝗖𝗔𝗟𝗟 (𝗨𝗣)' : '📉 𝗣𝗨𝗧 (𝗗𝗢𝗪𝗡)';
  return (
    `╔════════════════════╗\n` +
    `          🚀 𝗤𝗫 𝗔𝗜 𝗟𝗜𝗩𝗘 𝗩𝟭𝟬.𝟬\n` +
    `╚════════════════════╝\n\n` +
    `💹 𝗔𝗦𝗦𝗘𝗧      ➜ ${signal.symbol} ${flag}\n` +
    `🎯 𝗗𝗜𝗥𝗘𝗖𝗧𝗜𝗢𝗡 ➜ ${dirLabel}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🎯 𝗤𝗫 𝗦𝗖𝗢𝗥𝗘 ➜ ${signal.scoreLabel} ${signal.aiScore}%\n` +
    `💰 𝗘𝗡𝗧𝗥𝗬 𝗣𝗥𝗜𝗖𝗘 ➜ ${entryPrice.toFixed(5)}\n` +
    `⏰ 𝗘𝗡𝗧𝗥𝗬 𝗧𝗜𝗠𝗘 ➜ ${entryTimeStr} (𝗕𝗗)\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🛡️ 𝗥𝗜𝗦𝗞 𝗠𝗔𝗡𝗔𝗚𝗘𝗠𝗘𝗡𝗧\n` +
    `⚠️ 𝗠𝗔𝗫 𝟭 𝗦𝗧𝗘𝗣 𝗠𝗧𝗚\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🤖 𝗣𝗢𝗪𝗘𝗥𝗘𝗗 𝗕𝗬 𝗤𝗫 𝗔𝗜 𝗧𝗥𝗔𝗗𝗘𝗥 𝗩𝟭𝟬.𝟬\n` +
    `⚠️ Trade at your own risk.`
  );
}

function buildResultMessage(signal, flag, entryPrice, exitPrice, isWin) {
  return (
    `🏆 𝗦𝗜𝗚𝗡𝗔𝗟 𝗥𝗘𝗦𝗨𝗟𝗧\n\n` +
    `📊 𝗔𝗦𝗦𝗘𝗧: ${signal.symbol} ${flag}\n` +
    `💰 𝗘𝗡𝗧𝗥𝗬: ${entryPrice.toFixed(5)}\n` +
    `🎯 𝗖𝗟𝗢𝗦𝗘: ${exitPrice.toFixed(5)}\n\n` +
    `🏆 𝗥𝗘𝗦𝗨𝗟𝗧: ${isWin ? '✅ 𝗪𝗜𝗡 🎉' : '❌ 𝗟𝗢𝗦𝗦'}\n\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `🤖 𝗣𝗢𝗪𝗘𝗥𝗘𝗗 𝗕𝗬 𝗤𝗫 𝗔𝗜`
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🎯 MAIN SIGNAL ROUND
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function runSignalRound(bot, signal, isMTG = false) {
  const pairInfo = SESSION_PAIRS.find(p => p.symbol === signal.symbol);
  const flag = pairInfo ? pairInfo.flag : (signal.flag || '');

  console.log(`⏳ [${signal.symbol}] Waiting for verification window (45s before entry)...`);
  await waitForVerificationTime();

  console.log(`🔎 [${signal.symbol}] Re-verifying last closed candle...`);
  const verification = await reverifySignal(signal);
  if (!verification.confirmed) {
    console.log(`🚫 [${signal.symbol}] Signal CANCELLED — direction/confidence changed. No message sent.`);
    tracker.addCancelled();
    learner.logResult({
      source: 'session',
      symbol: signal.symbol,
      direction: signal.direction,
      aiScore: signal.aiScore,
      signals: signal.signals,
      finalResult: 'UNVERIFIED'
    }).catch(e => console.log('learner.logResult (session cancelled) error:', e.message));
    return { cancelled: true };
  }
  signal = { ...signal, ...verification.updatedData };
  console.log(`✅ [${signal.symbol}] Re-verified — direction unchanged (${signal.direction}, ${signal.aiScore}%)`);

  await waitForCandleOpen();
  console.log(`🔔 TRADE START!`);

  let entryPrice = signal.currentPrice;
  try {
    const p = await getCurrentPrice(signal.symbol);
    if (p) entryPrice = p;
  } catch (e) {
    console.log(`⚠️ Price fetch failed: ${e.message}`);
  }

  const entryTimeStr = getBDTime().fullTime;
  console.log(`💰 Entry Price: ${entryPrice} @ ${entryTimeStr}`);

  const badgeType = signal.direction === 'UP' ? 'CALL' : 'PUT';
  const dirSticker = signal.direction === 'UP' ? STICKERS.CALL : STICKERS.PUT;

  // ✅ FIX: caption (with ASSET name) + chart go out FIRST, so people always know
  // which pair the signal is for before any direction cue appears. The CALL/PUT
  // sticker is purely decorative and comes AFTER.
  const finalChart = await generateCandleChart(signal.symbol, signal.candles, entryPrice, null, badgeType, `M1 • ${entryTimeStr} (UTC+6) • CONFIDENCE ${signal.aiScore}% • LIVE MARKET`);
  const finalCaption = buildFinalSignalCaption(signal, flag, entryPrice, entryTimeStr, badgeType);

  if (finalChart) {
    await safeSendPhoto(bot, finalChart, finalCaption);
  } else {
    await safeSendMessage(bot, finalCaption, { parse_mode: 'Markdown' });
  }

  await safeSendSticker(bot, dirSticker);

  console.log(`⏳ Waiting for candle close...`);
  await waitForCandleClose();
  await sleep(1500);
  console.log(`⏹️ Candle Closed!`);

  let exitPrice = entryPrice;
  try {
    const p = await getCurrentPrice(signal.symbol);
    if (p) exitPrice = p;
  } catch (e) {
    console.log(`⚠️ Exit price fetch failed: ${e.message}`);
  }

  console.log(`💰 Exit Price: ${exitPrice}`);

  const isWin = (signal.direction === 'UP' && exitPrice > entryPrice) ||
                (signal.direction === 'DOWN' && exitPrice < entryPrice);

  console.log(`📊 ${signal.symbol} | Entry: ${entryPrice} | Exit: ${exitPrice} | ${isWin ? 'WIN ✅' : 'LOSS ❌'}${isMTG ? ' (MTG)' : ''}`);

  if (!isMTG) {
    lastResults.push(isWin);
    if (lastResults.length > 10) lastResults.shift();
  }
  tracker.addResult(signal.symbol, signal.direction, isWin, isMTG);

  // ✅ নতুন — এই main round-এর ফলাফল learner.js (MongoDB) এ log হচ্ছে
  learner.logResult({
    source: 'session',
    symbol: signal.symbol,
    direction: signal.direction,
    entryTime: entryTimeStr,
    entryPrice,
    exitPrice,
    aiScore: signal.aiScore,
    signals: signal.signals,
    isLive: true,
    directResult: isWin ? 'WIN' : 'LOSS',
    mtgResult: null,
    finalResult: isWin ? 'DIRECT_WIN' : 'FINAL_LOSS'
  }).catch(e => console.log('learner.logResult (session main) error:', e.message));

  if (isWin) await safeSendSticker(bot, STICKERS.SURESHOT);
  await safeSendMessage(bot, buildResultMessage(signal, flag, entryPrice, exitPrice, isWin), { parse_mode: 'Markdown' });

  return { isWin, entryPrice, exitPrice, flag, cancelled: false };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🔄 MTG STEP 2 — same direction, immediate next candle
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// By the time the main round's result is computed, we've already waited past
// the losing candle's close (xx:xx:58-59 + buffer). That moment IS the open of
// the next candle. So there's no fresh "waitForCandleOpen" needed here — we
// just grab the live price right now as the MTG entry (this equals the losing
// candle's close unless the market genuinely gapped, in which case the live
// price correctly reflects that gap), then wait for THIS candle to close.
async function runMtgRound(bot, signal, mainResult) {
  const pairInfo = SESSION_PAIRS.find(p => p.symbol === signal.symbol);
  const flag = pairInfo ? pairInfo.flag : (signal.flag || '');

  let entryPrice = mainResult.exitPrice; // fallback: previous candle's close
  try {
    const p = await getCurrentPrice(signal.symbol);
    if (p) entryPrice = p;
  } catch (e) {
    console.log(`⚠️ MTG entry price fetch failed: ${e.message}`);
  }
  const entryTimeStr = getBDTime().fullTime;
  console.log(`🔄 [MTG] ${signal.symbol} entry: ${entryPrice} @ ${entryTimeStr} (same direction: ${signal.direction})`);

  await waitForCandleClose();
  await sleep(1500);

  let exitPrice = entryPrice;
  try {
    const p = await getCurrentPrice(signal.symbol);
    if (p) exitPrice = p;
  } catch (e) {
    console.log(`⚠️ MTG exit price fetch failed: ${e.message}`);
  }

  const isWin = (signal.direction === 'UP' && exitPrice > entryPrice) ||
                (signal.direction === 'DOWN' && exitPrice < entryPrice);

  console.log(`🔄 [MTG] ${signal.symbol} | Entry: ${entryPrice} | Exit: ${exitPrice} | ${isWin ? 'WIN ✅' : 'LOSS ❌'}`);

  tracker.addResult(signal.symbol, signal.direction, isWin, true);

  // ✅ নতুন — MTG round-এর ফলাফলও learner.js (MongoDB) এ log হচ্ছে
  learner.logResult({
    source: 'session',
    symbol: signal.symbol,
    direction: signal.direction,
    entryTime: entryTimeStr,
    entryPrice,
    exitPrice,
    aiScore: signal.aiScore,
    signals: signal.signals,
    isLive: true,
    directResult: 'LOSS',
    mtgResult: isWin ? 'WIN' : 'LOSS',
    finalResult: isWin ? 'MTG_WIN' : 'FINAL_LOSS'
  }).catch(e => console.log('learner.logResult (session mtg) error:', e.message));

  if (isWin) await safeSendSticker(bot, STICKERS.SURESHOT);
  await safeSendMessage(
    bot,
    buildResultMessage(signal, flag, entryPrice, exitPrice, isWin) + `\n\n🔄 (𝗠𝗧𝗚 𝗦𝘁𝗲𝗽 𝟮 𝗥𝗲𝘀𝘂𝗹𝘁)`,
    { parse_mode: 'Markdown' }
  );

  return { isWin, entryPrice, exitPrice };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🎯 PRO SIGNAL SENDER (Main + MTG)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function sendProSignal(bot, signal) {
  const signalKey = generateSignalKey(signal.symbol, signal.direction);
  if (sentSignals.has(signalKey)) {
    console.log(`⚠️ Duplicate signal: ${signalKey}`);
    return null;
  }
  sentSignals.set(signalKey, Date.now());

  try {
    const main = await runSignalRound(bot, signal, false);

    if (main.cancelled) {
      return null;
    }

    if (main.isWin) {
      return true;
    }

    // ✅ FIX: MTG is NOT a fresh 3-5min re-analysis. Per spec: same direction, on the
    // candle that IS ALREADY OPEN right now (the one immediately after the losing
    // candle). Entry = actual current price (which naturally equals the previous
    // candle's close unless a real gap just happened — no special-casing needed,
    // fetching the live price handles both cases correctly).
    await safeSendMessage(bot,
      `🔄 𝗠𝗧𝗚 𝗦𝗧𝗘𝗣 𝟮 (𝗦𝗔𝗠𝗘 𝗗𝗜𝗥𝗘𝗖𝗧𝗜𝗢𝗡, 𝗡𝗘𝗫𝗧 𝗖𝗔𝗡𝗗𝗟𝗘)\n\n` +
      `📊 𝗔𝗦𝗦𝗘𝗧 ➜ ${signal.symbol} ${main.flag}\n` +
      `স্বয়ংক্রিয়ভাবে চলছে, ম্যানুয়ালি কিছু করার দরকার নেই।`,
      { parse_mode: 'Markdown' }
    );

    const mtgResult = await runMtgRound(bot, signal, main);
    return mtgResult.isWin;

  } catch (error) {
    console.error(`❌ Signal error for ${signal.symbol}: ${error.message}`);
    return null;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🏁 MAIN SESSION RUNNER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function runSession(bot, sessionName, isManual = false) {
  const sessionKey = generateSessionKey(sessionName);

  if (emergencyChecker()) {
    console.log(`🛑 ${sessionName} — Emergency Mode চালু, session শুরু হবে না।`);
    return { started: false, reason: 'emergency_mode' };
  }

  if (!isManual && completedSessions.has(sessionKey)) {
    const lastRun = completedSessions.get(sessionKey);
    if (Date.now() - lastRun < 25 * 60 * 1000) {
      console.log(`⚠️ ${sessionName} already completed recently.`);
      return { started: false, reason: 'already_completed' };
    }
  }

  if (!acquireSessionLock(sessionName)) {
    console.log(`⚠️ ${sessionName} — another session is running.`);
    return { started: false, reason: 'already_running' };
  }

  stopRequested = false;
  sessionPaused = false;

  try {
    console.log(`🏁 ${sessionName} Session Started`);
    completedSessions.set(sessionKey, Date.now());

    await safeSendSticker(bot, STICKERS.SESSION_START);
    await sleep(1500);
    await safeSendMessage(bot, SESSION_INTRO_MESSAGE, { parse_mode: 'Markdown' });

    await sleep(2 * 60 * 1000);
    await safeSendSticker(bot, STICKERS.ARE_YOU_READY);
    await sleep(3000);

    const MAX_SIGNALS = 5;
    const WIN_STREAK_TO_CLOSE = 3;
    let signalCount = 0;
    let winCount = 0;
    let lossCount = 0;
    let currentWinStreak = 0;
    // ✅ ফিক্স — আগে "isFirstSignal" শুধু লুপ-অ্যাটেম্পট গোনা হতো, তাই duplicate/cancelled/
    // error signal (যেগুলো আসলে চ্যানেলে কোনো সিগন্যাল কার্ডই পাঠায়নি) হলেও পরের
    // অ্যাটেম্পটে NEXT_ONE sticker পাঠিয়ে দিত — এভাবেই ৫-৬-৭ বার sticker স্প্যাম হতো।
    // এখন এটা শুধু তখনই true হবে যখন অন্তত একটা সিগন্যাল রাউন্ড সত্যিই সম্পন্ন হয়েছে।
    let hasSentAnySignal = false;
    let lastSignalTime = Date.now();
    const MIN_SIGNAL_GAP = 5 * 60 * 1000;
    const MAX_SIGNAL_GAP = 15 * 60 * 1000;
    const SESSION_MAX_DURATION = 90 * 60 * 1000;

    const sessionStart = Date.now();
    let stoppedEarly = false;

    while (signalCount < MAX_SIGNALS && Date.now() - sessionStart < SESSION_MAX_DURATION) {
      if (!sessionRunning) { console.log(`⚠️ Session lock lost, stopping`); break; }

      // ✅ নতুন — Stop/Emergency চেক (রাউন্ডের মাঝখানে না, পরের সিগন্যাল খোঁজার আগে)
      if (stopRequested || emergencyChecker()) {
        console.log(`⏹ ${sessionName} — Stop requested or Emergency Mode, ending session.`);
        stoppedEarly = true;
        break;
      }

      // ✅ নতুন — Pause চেক (paused অবস্থায় লুপ এখানেই আটকে থাকবে)
      while (sessionPaused) {
        await sleep(2000);
        if (stopRequested || emergencyChecker()) break;
      }
      if (stopRequested || emergencyChecker()) {
        stoppedEarly = true;
        break;
      }

      if (currentWinStreak >= WIN_STREAK_TO_CLOSE) {
        console.log(`🏆 ${WIN_STREAK_TO_CLOSE} consecutive wins — closing session early`);
        break;
      }

      const gapSinceLast = Date.now() - lastSignalTime;
      const forceRelaxed = gapSinceLast >= MAX_SIGNAL_GAP;

      let best = null;
      try {
        best = await findBestPair(isManual, forceRelaxed);
      } catch (e) {
        console.error(`❌ Error: ${e.message}`);
        await sleep(60000);
        continue;
      }

      if (!best) {
        console.log('⏭️ No valid signal, retrying in 3 min...');
        await sleep(3 * 60 * 1000);
        continue;
      }

      if (hasSentAnySignal && gapSinceLast < MIN_SIGNAL_GAP) {
        await sleep(MIN_SIGNAL_GAP - gapSinceLast);
      }

      if (hasSentAnySignal) { await safeSendSticker(bot, STICKERS.NEXT_ONE); await sleep(2000); }

      try {
        const isWin = await sendProSignal(bot, best);
        if (isWin !== null) {
          hasSentAnySignal = true;
          signalCount++;
          lastSignalTime = Date.now();
          if (isWin) { winCount++; currentWinStreak++; }
          else { lossCount++; currentWinStreak = 0; }
        } else {
          await sleep(30 * 1000);
        }
      } catch (e) {
        console.error(`❌ Signal error: ${e.message}`);
      }

      if (signalCount < MAX_SIGNALS && currentWinStreak < WIN_STREAK_TO_CLOSE) {
        await sleep(60 * 1000);
      }
    }

    await sleep(2000);
    await safeSendSticker(bot, STICKERS.SESSION_CLOSE);
    await sleep(800);

    if (stoppedEarly) {
      await safeSendMessage(bot,
        `⏹ **𝗦𝗘𝗦𝗦𝗜𝗢𝗡 𝗦𝗧𝗢𝗣𝗣𝗘𝗗**\n\n` +
        `📊 **Total Signals:** ${signalCount}\n` +
        `🟢 **WIN:** ${winCount}\n` +
        `🔴 **LOSS:** ${lossCount}\n\n` +
        `🛠 Admin দ্বারা থামানো হয়েছে।\n\n` +
        `🤖 **𝗤𝗫 𝗔𝗜 𝗧𝗥𝗔𝗗𝗘𝗥 𝗩𝟭𝟬.𝟬**`,
        { parse_mode: 'Markdown' }
      );
    } else if (winCount > lossCount) {
      await safeSendMessage(bot,
        `🏆 **𝗦𝗘𝗦𝗦𝗜𝗢𝗡 𝗥𝗘𝗦𝗨𝗟𝗧**\n\n` +
        `📊 **Total Signals:** ${signalCount}\n` +
        `🟢 **WIN:** ${winCount}\n` +
        `🔴 **LOSS:** ${lossCount}\n\n` +
        `💬 **Feedback:** @AkiL_xD\n` +
        `🤖 **𝗤𝗫 𝗔𝗜 𝗧𝗥𝗔𝗗𝗘𝗥 𝗩𝟭𝟬.𝟬**`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await safeSendMessage(bot,
        `📊 **𝗦𝗘𝗦𝗦𝗜𝗢𝗡 𝗥𝗘𝗦𝗨𝗟𝗧**\n\n` +
        `📈 **Total Signals:** ${signalCount}\n` +
        `🟢 **WIN:** ${winCount}\n` +
        `🔴 **LOSS:** ${lossCount}\n\n` +
        `🙏 **Thank You for Staying With Us.**\n` +
        `📅 **We'll Be Back With Better Setups.**\n\n` +
        `🤖 **𝗤𝗫 𝗔𝗜 𝗧𝗥𝗔𝗗𝗘𝗥 𝗩𝟭𝟬.𝟬**`,
        { parse_mode: 'Markdown' }
      );
    }

    console.log(`✅ ${sessionName} Ended | Total: ${signalCount} | W:${winCount} L:${lossCount}`);
    return { started: true, signalCount, winCount, lossCount, stoppedEarly };

  } catch (err) {
    console.error(`💥 Session error: ${err.message}`);
    throw err;
  } finally {
    releaseSessionLock();
    cleanupOldEntries();
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ✅ নতুন — Pause / Resume / Stop কন্ট্রোল ফাংশন
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function pauseSessionInternal() {
  if (!sessionRunning) return false;
  sessionPaused = true;
  console.log('⏸ Session paused by admin');
  return true;
}

function resumeSessionInternal() {
  if (!sessionPaused) return false;
  sessionPaused = false;
  console.log('▶ Session resumed by admin');
  return true;
}

function stopSessionInternal() {
  if (!sessionRunning) return false;
  stopRequested = true;
  sessionPaused = false;
  console.log('⏹ Session stop requested by admin');
  return true;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ⏰ AUTO SCHEDULER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

module.exports = function (bot) {
  if (schedulerInitialized) { console.log('⚠️ Scheduler already initialized'); return; }
  schedulerInitialized = true;
  console.log('✅ Scheduler started (v10.2 — Silent Analysis → 45s Re-Verify → ONE Final Signal → Result + Pause/Stop/Emergency)');

  if (schedulerInterval) clearInterval(schedulerInterval);

  schedulerInterval = setInterval(async () => {
    try {
      const { h, m, s, dateKey } = getBDTime();

      if (h === 13 && m === 30 && s < 10) {
        const key = generateReminderKey('afternoon_reminder');
        if (!sentReminders.has(key) && !emergencyChecker()) {
          sentReminders.set(key, Date.now());
          await safeSendMessage(bot,
            `⏰ **Afternoon Session শুরু হবে ৩০ মিনিট পরে!**\n\n🕑 ২:০০ টায় (BD Time)\n📊 সবাই রেডি থাকুন! ✅`,
            { parse_mode: 'Markdown' }
          );
        }
      }
      if (h === 14 && m === 0 && s < 10) {
        const key = generateSessionKey('🌤️ Afternoon');
        if (!completedSessions.has(key) && !isSessionLocked() && !emergencyChecker()) {
          runSession(bot, '🌤️ Afternoon', false).catch(e => console.error(e.message));
        }
      }

      if (h === 20 && m === 30 && s < 10) {
        const key = generateReminderKey('night_reminder');
        if (!sentReminders.has(key) && !emergencyChecker()) {
          sentReminders.set(key, Date.now());
          await safeSendMessage(bot,
            `🌙 **Night Session শুরু হবে ৩০ মিনিট পরে!**\n\n🕘 রাত ৯:০০ টায় (BD Time)\n📊 সবাই রেডি থাকুন! ✅`,
            { parse_mode: 'Markdown' }
          );
        }
      }
      if (h === 21 && m === 0 && s < 10) {
        const key = generateSessionKey('🌙 Night');
        if (!completedSessions.has(key) && !isSessionLocked() && !emergencyChecker()) {
          runSession(bot, '🌙 Night', false).catch(e => console.error(e.message));
        }
      }

      // ✅ ফিক্স — পাবলিক চ্যানেলে ৩০-দিনের raw win-rate রিপোর্ট আর পাঠানো হবে না
      // (learner.js এখন admin-কে একবার রাতে unified report পাঠায়; এটা মেম্বারদের
      // কাছে পুরনো/খারাপ win-rate সরাসরি প্রকাশ করছিল)

      if (m === 0 && s < 10) cleanupOldEntries();

    } catch (e) {
      console.error('Scheduler error:', e.message);
    }
  }, 5000);
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 📤 EXPORTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

module.exports.runSession = (bot, sessionName) => runSession(bot, sessionName, true);
module.exports.isSessionRunning = () => sessionRunning;
// ⚠️ NOTE: এখন async (Promise<string> রিটার্ন করে), আগে ছিল sync (string সরাসরি)।
// যদি অন্য কোথাও sessionModule.getStats() কে সরাসরি bot.sendMessage()-এ পাঠানো হয়ে
// থাকে (await ছাড়া), সেটা এখন ভেঙে যাবে — await sessionModule.getStats() ব্যবহার করতে হবে।
module.exports.getStats = () => tracker.getStatsMessage();

// ✅ নতুন — Pause / Resume / Stop / Emergency exports
module.exports.pauseSession = pauseSessionInternal;
module.exports.resumeSession = resumeSessionInternal;
module.exports.stopSessionNow = stopSessionInternal;
module.exports.isPaused = () => sessionPaused;
module.exports.setEmergencyChecker = (fn) => { if (typeof fn === 'function') emergencyChecker = fn; };

module.exports.cleanup = () => {
  if (schedulerInterval) { clearInterval(schedulerInterval); schedulerInterval = null; }
  schedulerInitialized = false;
  releaseSessionLock();
  console.log('✅ Cleaned up');
};
