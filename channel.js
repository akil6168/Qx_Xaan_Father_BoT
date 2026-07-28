// channel.js - Qx AI Predictor VIP (v5.2 - 20 High Accuracy Indicators + Daily Report + Emergency Mode support)
const https = require('https');
const fs = require('fs');
const path = require('path');
const learner = require('./learner');

const CHANNEL_ID = '-1002427080688';
const ADMIN_ID = 5724602667;

// ✅ নতুন — একটাই TWELVE_DATA_KEYS_CHANNEL Variable, কমা (,) দিয়ে আলাদা করা key
// Railway-তে TWELVE_DATA_KEYS_CHANNEL=key1,key2,key3... দিলে সেটাই ব্যবহার হবে
// না থাকলে পুরনো ফরম্যাট (TWELVE_DATA_KEY, TWELVE_DATA_KEY_1..10) ব্যবহার হবে (backward-compatible)
const API_KEYS = (process.env.TWELVE_DATA_KEYS_CHANNEL
  ? process.env.TWELVE_DATA_KEYS_CHANNEL.split(',').map(k => k.trim()).filter(Boolean)
  : [
      process.env.TWELVE_DATA_KEY,
      process.env.TWELVE_DATA_KEY_1,
      process.env.TWELVE_DATA_KEY_2,
      process.env.TWELVE_DATA_KEY_3,
      process.env.TWELVE_DATA_KEY_4,
      process.env.TWELVE_DATA_KEY_5,
      process.env.TWELVE_DATA_KEY_6,
      process.env.TWELVE_DATA_KEY_7,
      process.env.TWELVE_DATA_KEY_8,
      process.env.TWELVE_DATA_KEY_9,
      process.env.TWELVE_DATA_KEY_10
    ].filter(Boolean)
);

let apiKeyIndex = 0;
function getNextApiKey() {
  const key = API_KEYS[apiKeyIndex % API_KEYS.length];
  apiKeyIndex++;
  return key;
}

const CHECK_INTERVAL = 60 * 1000;
const MIN_GAP = 5 * 60 * 1000;
const MAX_GAP = 15 * 60 * 1000;
const CONFIRM_LIMIT = 5;
const STALE_MINUTES = 5;

const pairGroups = [
  [
    { live: 'EUR/USD', otc: 'EUR/USD OTC', flag: '🇪🇺🇺🇸' },
    { live: 'GBP/USD', otc: 'GBP/USD OTC', flag: '🇬🇧🇺🇸' },
    { live: 'USD/JPY', otc: 'USD/JPY OTC', flag: '🇺🇸🇯🇵' },
    { live: 'AUD/USD', otc: 'AUD/USD OTC', flag: '🇦🇺🇺🇸' }
  ],
  [
    { live: 'USD/CAD', otc: 'USD/CAD OTC', flag: '🇺🇸🇨🇦' },
    { live: 'USD/CHF', otc: 'USD/CHF OTC', flag: '🇺🇸🇨🇭' },
    { live: 'EUR/JPY', otc: 'EUR/JPY OTC', flag: '🇪🇺🇯🇵' },
    { live: 'GBP/JPY', otc: 'GBP/JPY OTC', flag: '🇬🇧🇯🇵' }
  ]
];

let pairGroupIndex = 0;
let lastSentTime = 0;
let lastMarketStatus = null;
let liveCount = 0;
let noLiveCount = 0;
let lastSignalKey = '';

let dailyStats = { dateKey: null, total: 0, wins: 0, losses: 0 };
let reportSentDateKey = null;

function getBDTime() {
  const bd = new Date(Date.now() + 6 * 60 * 60 * 1000);
  const h = bd.getUTCHours(), m = bd.getUTCMinutes(), s = bd.getUTCSeconds();
  return {
    h: String(h).padStart(2, '0'),
    m: String(m).padStart(2, '0'),
    s: String(s).padStart(2, '0'),
    day: bd.getUTCDay(),
    hour: h,
    minute: m,
    bd,
    display: `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`
  };
}

function currentDateKey() {
  const bd = new Date(Date.now() + 6 * 60 * 60 * 1000);
  return `${bd.getUTCFullYear()}-${String(bd.getUTCMonth() + 1).padStart(2, '0')}-${String(bd.getUTCDate()).padStart(2, '0')}`;
}

function formatReportDate(dateKeyStr) {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const [y, mo, d] = dateKeyStr.split('-').map(Number);
  return `${d} ${months[mo - 1]} ${y}`;
}

function toBoldSans(str) {
  return String(str).split('').map(ch => {
    const code = ch.charCodeAt(0);
    if (ch >= 'A' && ch <= 'Z') return String.fromCodePoint(0x1D5D4 + (code - 65));
    if (ch >= 'a' && ch <= 'z') return String.fromCodePoint(0x1D5EE + (code - 97));
    if (ch >= '0' && ch <= '9') return String.fromCodePoint(0x1D7EC + (code - 48));
    return ch;
  }).join('');
}

function getEntryExpiry() {
  const bd = new Date(Date.now() + 6 * 60 * 60 * 1000);
  const h = bd.getUTCHours();
  const m = bd.getUTCMinutes();
  const eM = m + 1, xM = m + 2;
  return {
    entry: `${String((h + Math.floor(eM / 60)) % 24).padStart(2, '0')}:${String(eM % 60).padStart(2, '0')}`,
    expiry: `${String((h + Math.floor(xM / 60)) % 24).padStart(2, '0')}:${String(xM % 60).padStart(2, '0')}`
  };
}

function isLiveMarketOpen() {
  const { day, hour } = getBDTime();
  if (day === 6) return false;
  if (day === 0) return false;
  if (day === 1 && hour < 11) return false;
  if (day === 5 && hour >= 23) return false;
  if (hour >= 23) return false;
  if (hour < 11) return false;
  return true;
}

function isRolloverTime() {
  const { hour, minute } = getBDTime();
  if (hour === 23 && minute >= 58) return true;
  if (hour === 0 && minute < 20) return true;
  return false;
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function getCandles(symbol) {
  const apiKey = getNextApiKey();
  const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=1min&outputsize=60&apikey=${apiKey}`;
  const data = await fetchJSON(url);
  if (!data.values || !data.values.length) throw new Error('No data');

  const lastCandleTime = new Date(data.values[0].datetime + ' UTC');
  const diffMinutes = (new Date() - lastCandleTime) / (60 * 1000);
  if (diffMinutes > STALE_MINUTES) {
    throw new Error('Stale data: ' + Math.round(diffMinutes) + ' min old');
  }

  return data.values.map(v => ({
    open: +v.open, high: +v.high, low: +v.low,
    close: +v.close, volume: +v.volume || 0,
    datetime: v.datetime
  })).reverse();
}

function buildHigherTF(candles1m, period) {
  const result = [];
  for (let i = 0; i + period <= candles1m.length; i += period) {
    const sl = candles1m.slice(i, i + period);
    result.push({
      open: sl[0].open,
      high: Math.max(...sl.map(c => c.high)),
      low: Math.min(...sl.map(c => c.low)),
      close: sl[sl.length - 1].close,
      volume: sl.reduce((a, b) => a + b.volume, 0)
    });
  }
  return result;
}

function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) return 50;
  let gain = 0, loss = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    d > 0 ? gain += d : loss += Math.abs(d);
  }
  return 100 - (100 / (1 + gain / (loss || 1)));
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
    tr.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i-1].close),
      Math.abs(candles[i].low - candles[i-1].close)
    ));
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
  const sma = closes.reduce((a, b) => a + b, 0) / p;
  const std = Math.sqrt(closes.reduce((s, c) => s + Math.pow(c - sma, 2), 0) / p);
  return { upper: sma + 2 * std, lower: sma - 2 * std, mid: sma };
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
  return { dir };
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
  return { dir: last > vwap ? 'UP' : 'DOWN' };
}

function calcATR(candles, period = 14) {
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    ));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcEMA(candles, period) {
  if (candles.length < 2) return candles[0].close;
  const k = 2 / (period + 1);
  let ema = candles[0].close;
  for (let i = 1; i < candles.length; i++) ema = candles[i].close * k + ema * (1 - k);
  return ema;
}

function calcStochRSI(candles, period = 14) {
  const rsiArr = [];
  for (let i = period; i < candles.length; i++)
    rsiArr.push(calcRSI(candles.slice(0, i + 1), period));
  if (rsiArr.length < period) return 50;
  const rec = rsiArr.slice(-period);
  const mn = Math.min(...rec), mx = Math.max(...rec);
  if (mx === mn) return 50;
  return ((rsiArr[rsiArr.length - 1] - mn) / (mx - mn)) * 100;
}

function calcCCI(candles, period = 20) {
  const p = Math.min(period, candles.length);
  const slice = candles.slice(-p);
  const typicals = slice.map(c => (c.high + c.low + c.close) / 3);
  const mean = typicals.reduce((a,b) => a+b, 0) / p;
  const mad = typicals.reduce((s,t) => s + Math.abs(t - mean), 0) / p;
  if (mad === 0) return 0;
  return (typicals[typicals.length - 1] - mean) / (0.015 * mad);
}

function calcWilliamsR(candles, period = 14) {
  const p = Math.min(period, candles.length);
  const slice = candles.slice(-p);
  const highest = Math.max(...slice.map(c => c.high));
  const lowest = Math.min(...slice.map(c => c.low));
  const last = candles[candles.length - 1].close;
  if (highest === lowest) return -50;
  return ((highest - last) / (highest - lowest)) * -100;
}

function calcIchimoku(candles) {
  const len = candles.length;
  if (len < 52) return { trend: 'NEUTRAL', up: 0, dn: 0 };
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
  if (last > senkouA && last > senkouB) up += 3;
  else if (last < senkouA && last < senkouB) dn += 3;
  if (tenkan > kijun) up += 2; else dn += 2;
  if (chikou > last) up += 2; else dn += 2;
  return { trend: up > dn ? 'UP' : 'DOWN', up, dn };
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
  return { near618, above618, dir: above618 ? 'UP' : 'DOWN' };
}

function calcChaikinMF(candles, period = 21) {
  if (candles.length < period) return 0;
  let sumMF = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i];
    const mf = ((c.close - c.low) - (c.high - c.close)) / (c.high - c.low) * (c.volume || 1);
    sumMF += mf;
  }
  const totalVol = candles.slice(-period).reduce((s, c) => s + (c.volume || 1), 0);
  return totalVol > 0 ? sumMF / totalVol : 0;
}

function calcParabolicSAR(candles) {
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2] || last;
  const isUptrend = last.close > prev.close;
  return { dir: isUptrend ? 'UP' : 'DOWN' };
}

function calcOBV(candles) {
  let obv = 0;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i-1].close) obv += candles[i].volume;
    else if (candles[i].close < candles[i-1].close) obv -= candles[i].volume;
  }
  const lastOBV = obv;
  const prevOBV = obv - (candles[candles.length-1].volume || 0);
  return { dir: lastOBV > prevOBV ? 'UP' : 'DOWN' };
}

function calcCandlePattern(candles) {
  const len = candles.length;
  if (len < 3) return { pattern: 'No Pattern', dir: 'NEUTRAL', str: 0 };
  const c = candles[len - 1], p = candles[len - 2], p2 = candles[len - 3];
  const body = Math.abs(c.close - c.open);
  const upWick = c.high - Math.max(c.close, c.open);
  const dnWick = Math.min(c.close, c.open) - c.low;
  const range = c.high - c.low || 0.0001;
  const bull = c.close > c.open, bear = c.close < c.open;

  if (bull && p.close < p.open && c.close > p.open && c.open < p.close)
    return { pattern: 'Bullish Engulfing', dir: 'UP', str: 4 };
  if (bear && p.close > p.open && c.open > p.close && c.close < p.open)
    return { pattern: 'Bearish Engulfing', dir: 'DOWN', str: 4 };
  if (dnWick > body * 2.5 && upWick < body * 0.5)
    return { pattern: 'Bullish Pin Bar', dir: 'UP', str: 3 };
  if (upWick > body * 2.5 && dnWick < body * 0.5)
    return { pattern: 'Bearish Pin Bar', dir: 'DOWN', str: 3 };
  if (body < range * 0.1)
    return { pattern: 'Doji', dir: 'NEUTRAL', str: 1 };
  return { pattern: 'No Pattern', dir: 'NEUTRAL', str: 0 };
}

function calcSR(candles) {
  const highs = candles.slice(-20).map(c => c.high);
  const lows = candles.slice(-20).map(c => c.low);
  const cur = candles[candles.length - 1].close;
  const resistance = Math.max(...highs);
  const support = Math.min(...lows);
  return {
    nearResistance: Math.abs(cur - resistance) / cur < 0.001,
    nearSupport: Math.abs(cur - support) / cur < 0.001
  };
}

function calcTrendStrength(candles) {
  const ema5 = calcEMA(candles, 5);
  const ema10 = calcEMA(candles, 10);
  const ema20 = calcEMA(candles, 20);
  const ema50 = calcEMA(candles, 50);
  const last = candles[candles.length - 1].close;
  let up = 0, dn = 0;
  if (ema5 > ema20) up += 2; else dn += 2;
  if (ema10 > ema50) up += 2; else dn += 2;
  if (last > ema5) up += 1; else dn += 1;
  if (last > ema20) up += 1; else dn += 1;
  if (ema5 > ema10 && ema10 > ema20) up += 3;
  else if (ema5 < ema10 && ema10 < ema20) dn += 3;
  return { dir: up > dn ? 'UP' : 'DOWN', up, dn, isStrong: up >= 5 || dn >= 5 };
}

async function smartAnalyze(pair, forceOTC = false) {
  let candles1m;
  let isLive = false;

  if (!forceOTC) {
    try {
      candles1m = await getCandles(pair.live);
      isLive = true;
      console.log(pair.live + ' | ✅ Live');
    } catch (e) {
      console.log(pair.live + ' | ❌ ' + e.message);
    }
  }

  if (!candles1m) {
    try {
      candles1m = await getCandles(pair.live);
      isLive = false;
      console.log(pair.otc + ' | 📊 OTC');
    } catch (e) {
      console.log(pair.otc + ' | Failed — skip');
      return null;
    }
  }

  const candles5m = buildHigherTF(candles1m, 5);
  if (candles5m.length < 3) return null;

  const last = candles1m[candles1m.length - 1].close;
  const atr = calcATR(candles1m);
  const volatility = (atr / last) * 100;

  const rsi = calcRSI(candles1m);
  const macd = calcMACD(candles1m);
  const adx = calcADX(candles1m);
  const bb = calcBB(candles1m);
  const supertrend = calcSupertrend(candles1m);
  const vwap = calcVWAP(candles1m);
  const stoch = calcStochRSI(candles1m);
  const cci = calcCCI(candles1m);
  const wr = calcWilliamsR(candles1m);
  const ichimoku = calcIchimoku(candles1m);
  const mfi = calcMFI(candles1m);
  const fib = calcFibonacci(candles1m);
  const cmf = calcChaikinMF(candles1m);
  const psar = calcParabolicSAR(candles1m);
  const obv = calcOBV(candles1m);
  const cp = calcCandlePattern(candles1m);
  const sr = calcSR(candles1m);
  const trend = calcTrendStrength(candles1m);

  let up = 0, dn = 0;
  const signals = [];

  if (rsi < 30) { up += 3; signals.push('RSI Oversold'); }
  else if (rsi > 70) { dn += 3; signals.push('RSI Overbought'); }

  if (macd > 0) { up += 3; signals.push('MACD Bullish'); }
  else { dn += 3; signals.push('MACD Bearish'); }

  if (adx.adx >= 25) {
    if (adx.plusDI > adx.minusDI) { up += 3; signals.push(`ADX Strong ✅`); }
    else { dn += 3; signals.push(`ADX Strong ✅`); }
  }

  if (last <= bb.lower) { up += 3; signals.push('At Lower BB'); }
  else if (last >= bb.upper) { dn += 3; signals.push('At Upper BB'); }

  if (supertrend.dir === 'UP') { up += 3; signals.push('Supertrend Bullish'); }
  else if (supertrend.dir === 'DOWN') { dn += 3; signals.push('Supertrend Bearish'); }

  if (vwap.dir === 'UP') { up += 2; signals.push('Above VWAP'); }
  else { dn += 2; signals.push('Below VWAP'); }

  if (stoch < 20) { up += 2; signals.push('StochRSI Oversold'); }
  else if (stoch > 80) { dn += 2; signals.push('StochRSI Overbought'); }

  if (cci < -100) { up += 2; signals.push('CCI Oversold'); }
  else if (cci > 100) { dn += 2; signals.push('CCI Overbought'); }

  if (wr < -80) { up += 2; signals.push('Williams Oversold'); }
  else if (wr > -20) { dn += 2; signals.push('Williams Overbought'); }

  if (ichimoku.trend === 'UP') { up += 3; signals.push('Ichimoku Bullish'); }
  else if (ichimoku.trend === 'DOWN') { dn += 3; signals.push('Ichimoku Bearish'); }

  if (mfi < 20) { up += 3; signals.push('MFI Oversold'); }
  else if (mfi > 80) { dn += 3; signals.push('MFI Overbought'); }

  if (fib.near618) {
    if (fib.above618) { up += 3; signals.push('Fib 61.8% Support'); }
    else { dn += 3; signals.push('Fib 61.8% Resistance'); }
  }

  if (cmf > 0.1) { up += 2; signals.push('CMF Bullish'); }
  else if (cmf < -0.1) { dn += 2; signals.push('CMF Bearish'); }

  if (psar.dir === 'UP') { up += 2; signals.push('PSAR Bullish'); }
  else { dn += 2; signals.push('PSAR Bearish'); }

  if (obv.dir === 'UP') { up += 2; signals.push('OBV Bullish'); }
  else { dn += 2; signals.push('OBV Bearish'); }

  if (cp.dir === 'UP') { up += cp.str; signals.push(cp.pattern); }
  else if (cp.dir === 'DOWN') { dn += cp.str; signals.push(cp.pattern); }

  if (sr.nearSupport) { up += 3; signals.push('At Support'); }
  if (sr.nearResistance) { dn += 3; signals.push('At Resistance'); }

  up += trend.up; dn += trend.dn;
  if (trend.dir === 'UP') signals.push('Strong Trend UP');
  else signals.push('Strong Trend DOWN');

  const total = up + dn;
  const dominant = Math.max(up, dn);
  const ratio = total > 0 ? dominant / total : 0;
  const direction = up >= dn ? 'UP' : 'DOWN';
  const aiScore = Math.round(ratio * 100);

  let confidence;
  if (aiScore >= 85) confidence = 'Very High 🔥';
  else if (aiScore >= 75) confidence = 'High 🟢';
  else if (aiScore >= 65) confidence = 'Medium ⚡';
  else confidence = 'Low ⚠️';

  const tf5m = analyzeTimeframe(candles5m);

  if (aiScore < 65 || volatility < 0.002 || !trend.isStrong) {
    console.log((isLive ? pair.live : pair.otc) + ` | Score ${aiScore}% — skip`);
    return null;
  }

  const directionsAgree = [
    trend.dir,
    ichimoku.trend,
    supertrend.dir === 'NEUTRAL' ? direction : supertrend.dir,
    vwap.dir,
    adx.adx >= 25 ? (adx.plusDI > adx.minusDI ? 'UP' : 'DOWN') : direction,
    cmf > 0 ? 'UP' : 'DOWN',
    fib.above618 ? 'UP' : 'DOWN'
  ].filter(d => d === direction).length;

  if (directionsAgree < 4) {
    console.log((isLive ? pair.live : pair.otc) + ` | Agree ${directionsAgree}/7 — skip`);
    return null;
  }

  const trendDesc = direction === 'UP' ? 'Strong Uptrend 📈' : 'Strong Downtrend 📉';

  return {
    pair: isLive ? pair.live : pair.otc,
    flag: pair.flag,
    direction,
    confidence,
    aiScore,
    trend: trendDesc,
    signals: signals.slice(0, 5),
    avgRatio: ratio,
    isLive,
    directionsAgree,
    adx: adx.adx,
    currentPrice: last
  };
}

function buildSignalMessage(best, entry, expiry) {
  const dirLabel = best.direction === 'UP' ? '🟢 𝗕𝗨𝗬' : '🔴 𝗦𝗘𝗟𝗟';
  const dirEmoji = best.direction === 'UP' ? '⏫' : '⏬';
  const confidenceLabel = best.aiScore >= 85 ? '𝗩𝗲𝗿𝘆 𝗛𝗶𝗴𝗵 🔥' : '𝗛𝗶𝗴𝗵 🟢';

  return (
    `╔════════════════════╗\n` +
    ` 🚀 𝗤𝗫 𝗔𝗜 𝗣𝗥𝗘𝗗𝗜𝗖𝗧𝗢𝗥 𝗩𝟱.𝟬\n` +
    `╚════════════════════╝\n\n` +
    `💹 𝗔𝘀𝘀𝗲𝘁      ➜ ${best.pair} ${best.flag}\n` +
    `📈 𝗗𝗶𝗿𝗲𝗰𝘁𝗶𝗼𝗻 ➜ ${dirLabel} ${dirEmoji}\n` +
    `🕒 𝗘𝗻𝘁𝗿𝘆      ➜ ${entry} (BD)\n` +
    `⏳ 𝗘𝘅𝗽𝗶𝗿𝘆     ➜ 1 Minute\n\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `🎯 𝗖𝗼𝗻𝗳𝗶𝗱𝗲𝗻𝗰𝗲 ➜ ${confidenceLabel} (${best.aiScore}%)\n\n` +
    `⚠️ 𝗠𝗮𝘅 𝟭 𝗦𝘁𝗲𝗽 𝗠𝗧𝗚\n` +
    `🤖 𝗣𝗼𝘄𝗲𝗿𝗲𝗱 𝗯𝘆 𝗤𝗫 𝗔𝗜`
  );
}

async function buildDailyReport() {
  const dateStr = dailyStats.dateKey ? formatReportDate(dailyStats.dateKey) : formatReportDate(currentDateKey());

  let total = dailyStats.total, wins = dailyStats.wins, losses = dailyStats.losses;
  try {
    const learnerStats = await learner.getSourceDailyStats('channel');
    if (learnerStats) {
      total = learnerStats.total;
      wins = learnerStats.wins;
      losses = learnerStats.losses;
    }
  } catch (e) {
    console.log('⚠️ buildDailyReport learner fetch failed, using local fallback:', e.message);
  }

  const winRate = total > 0 ? Math.round((wins / total) * 100) : 0;

  return (
    `🏆 ${toBoldSans('QX AI DAILY REPORT')}\n\n` +
    `📅 ${toBoldSans('DATE')}         ➜ ${toBoldSans(dateStr)}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `📊 ${toBoldSans('TOTAL SIGNALS')} ➜ ${toBoldSans(String(total))}\n` +
    `🟢 ${toBoldSans('TOTAL WINS')}    ➜ ${toBoldSans(String(wins))}\n` +
    `🔴 ${toBoldSans('TOTAL LOSSES')}  ➜ ${toBoldSans(String(losses))}\n` +
    `📈 ${toBoldSans('WIN RATE')}      ➜ ${toBoldSans(winRate + '%')}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🙏 ${toBoldSans('Thank You for Trading With Us!')}\n\n` +
    `💬 ${toBoldSans('FEEDBACK')} ➜ @AkiL_xD\n` +
    `🚀 ${toBoldSans('QX AI V5.0')}`
  );
}

async function checkSignalResult(signal) {
  await new Promise(r => setTimeout(r, 70 * 1000));

  try {
    const symbol = signal.pair.replace(' OTC', '');
    const freshCandles = await getCandles(symbol);
    const exitPrice = freshCandles[freshCandles.length - 1].close;
    const isWin = signal.direction === 'UP' ? exitPrice > signal.currentPrice : exitPrice < signal.currentPrice;

    const nowKey = currentDateKey();
    if (dailyStats.dateKey !== nowKey) {
      dailyStats = { dateKey: nowKey, total: 0, wins: 0, losses: 0 };
    }

    dailyStats.total++;
    if (isWin) dailyStats.wins++; else dailyStats.losses++;

    console.log(`📊 Result: ${signal.pair} | ${signal.direction} | Entry:${signal.currentPrice} Exit:${exitPrice} | ${isWin ? 'WIN ✅' : 'LOSS ❌'}`);

    learner.logResult({
      source: 'channel',
      symbol: signal.pair,
      direction: signal.direction,
      entryPrice: signal.currentPrice,
      exitPrice,
      aiScore: signal.aiScore,
      signals: signal.signals,
      isLive: signal.isLive,
      finalResult: isWin ? 'DIRECT_WIN' : 'FINAL_LOSS',
      directResult: isWin ? 'WIN' : 'LOSS',
      mtgResult: null
    }).catch(e => console.log('learner.logResult (channel) error:', e.message));
  } catch (e) {
    console.log('⚠️ Could not verify result for', signal.pair, '-', e.message);
  }
}

function analyzeTimeframe(candles) {
  const rsi = calcRSI(candles);
  const macd = calcMACD(candles);
  const trend = calcTrendStrength(candles);
  const last = candles[candles.length - 1].close;
  const atr = calcATR(candles);
  const volatility = (atr / last) * 100;

  let up = 0, dn = 0;
  if (rsi < 30) up += 2; else if (rsi > 70) dn += 2;
  if (macd > 0) up += 2; else dn += 2;
  up += trend.up; dn += trend.dn;

  const total = up + dn;
  const dominant = Math.max(up, dn);
  const ratio = total > 0 ? dominant / total : 0;
  const direction = up >= dn ? 'UP' : 'DOWN';

  return { direction, ratio, volatility, isStrongTrend: trend.isStrong };
}

module.exports = function(bot, newsModule, isEmergency) {
  console.log('✅ Qx AI Predictor VIP v5.2 — 20 Indicators + Daily Report + Emergency Mode support started!');

  async function run() {
    if (typeof isEmergency === 'function' && isEmergency()) {
      console.log('🛑 Emergency mode — channel signal scan skipped');
      return;
    }

    if (newsModule && newsModule.isNewsActive()) {
      console.log('📰 News active — skip');
      return;
    }

    const bdNow = getBDTime();
    const dateKeyNow = currentDateKey();
    if (bdNow.hour === 0 && bdNow.minute >= 5 && bdNow.minute <= 9 && reportSentDateKey !== dateKeyNow) {
      reportSentDateKey = dateKeyNow;
      dailyStats = { dateKey: dateKeyNow, total: 0, wins: 0, losses: 0 };
    }

    if (isRolloverTime()) {
      console.log('⏸ Rollover/Report window — skip');
      return;
    }

    const now = Date.now();
    const elapsed = now - lastSentTime;
    if (lastSentTime > 0 && elapsed < MIN_GAP) return;

    const { h, m } = getBDTime();
    const liveOpen = isLiveMarketOpen();

    const currentPairs = pairGroups[pairGroupIndex % 2];
    pairGroupIndex++;

    console.log(`🔍 Scan BD: ${h}:${m} | Market: ${liveOpen ? '🟢 LIVE' : '🔴 OTC'} | Group: ${pairGroupIndex % 2 === 0 ? '1' : '2'}`);

    const results = [];
    let anyLive = false;

    for (const pair of currentPairs) {
      try {
        const res = await smartAnalyze(pair, !liveOpen);
        if (res) {
          results.push(res);
          if (res.isLive) anyLive = true;
        }
        await new Promise(r => setTimeout(r, 1200));
      } catch (e) {
        console.log('Error: ' + pair.live + ' — ' + e.message);
      }
    }

    if (anyLive) { liveCount++; noLiveCount = 0; }
    else { noLiveCount++; liveCount = 0; }

    const { h: ah, m: am } = getBDTime();

    if (liveCount >= CONFIRM_LIMIT && lastMarketStatus !== true) {
      lastMarketStatus = true;
      liveCount = 0;
      try {
        await bot.sendMessage(ADMIN_ID,
          `🟢 *Quotex Market OPEN*\n\n` +
          `📊 পরপর ${CONFIRM_LIMIT} বার Live Data পাওয়া গেছে\n` +
          `⏰ BD Time: \`${ah}:${am}\`\n\n` +
          `✅ Live Signal চালু হয়েছে।`,
          { parse_mode: 'Markdown' }
        );
      } catch (e) {}
    }

    if (noLiveCount >= CONFIRM_LIMIT && lastMarketStatus !== false) {
      lastMarketStatus = false;
      noLiveCount = 0;
      try {
        await bot.sendMessage(ADMIN_ID,
          `🔴 *Quotex Market CLOSED*\n\n` +
          `😴 পরপর ${CONFIRM_LIMIT} বার Live Data পাওয়া যায়নি\n` +
          `⏰ BD Time: \`${ah}:${am}\`\n\n` +
          `📊 OTC Signal চলছে।`,
          { parse_mode: 'Markdown' }
        );
      } catch (e) {}
    }

    if (!results.length) {
      console.log('❌ No signal found.');
      return;
    }

    results.sort((a, b) => b.avgRatio - a.avgRatio || b.aiScore - a.aiScore);
    const best = results[0];

    const signalKey = `${best.pair}_${best.direction}`;
    if (signalKey === lastSignalKey && elapsed < MAX_GAP) {
      console.log(`🔁 Duplicate — skip`);
      return;
    }

    const { entry, expiry } = getEntryExpiry();
    const msg = buildSignalMessage(best, entry, expiry);

    try {
      await bot.sendMessage(CHANNEL_ID, msg, { parse_mode: 'Markdown' });
      lastSentTime = Date.now();
      lastSignalKey = signalKey;
      console.log(`✅ Signal: ${best.pair} | ${best.aiScore}% | ${best.confidence} | ${best.isLive ? 'LIVE 🟢' : 'OTC 🔴'} | Agree: ${best.directionsAgree}/7`);

      if (best.isLive) {
        checkSignalResult(best).catch(e => console.log('Result check error:', e.message));
      } else {
        console.log('📊 OTC signal — not counted in daily stats');
      }
    } catch (e) {
      console.log('Send error: ' + e.message);
    }
  }

  setTimeout(() => {
    run();
    setInterval(run, CHECK_INTERVAL);
  }, 30000);
};
