// analysis-engine.js — v2: Multi-Layer Weighted Scoring + Market-Hours Check
const twelveData = require('./twelvedata');

// ─────────────────────────────────────────────
// 🕒 Market Hours (BD Time) — index.js এর isRealMarketOpen() এর সাথে সিঙ্ক
// ─────────────────────────────────────────────
function getBDTimeInfo() {
  const bd = new Date(Date.now() + 6 * 60 * 60 * 1000);
  return { hour: bd.getUTCHours(), minute: bd.getUTCMinutes(), day: bd.getUTCDay() };
}

function isRealMarketOpen() {
  const { hour, day } = getBDTimeInfo();
  if (day === 6) return false;
  if (day === 0) return false;
  if (day === 1 && hour < 11) return false;
  if (day === 5 && hour >= 23) return false;
  if (hour < 11 || hour >= 23) return false;
  return true;
}

// ─────────────────────────────────────────────
// 📐 বেসিক ইনডিকেটর
// ─────────────────────────────────────────────
function calcEMA(candles, period) {
  const k = 2 / (period + 1);
  let ema = candles[0].close;
  for (let i = 1; i < candles.length; i++) ema = candles[i].close * k + ema * (1 - k);
  return ema;
}

function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff > 0) gains += diff; else losses += Math.abs(diff);
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function calcRSISeries(candles, period = 14) {
  const series = [];
  for (let i = period; i < candles.length; i++) series.push(calcRSI(candles.slice(0, i + 1), period));
  return series;
}

function calcMACD(candles) {
  const ema12 = calcEMA(candles, 12);
  const ema26 = calcEMA(candles, 26);
  const macdLine = ema12 - ema26;
  const macdSeries = [];
  for (let i = 26; i < candles.length; i++) {
    const slice = candles.slice(0, i + 1);
    macdSeries.push(calcEMA(slice, 12) - calcEMA(slice, 26));
  }
  const signalLine = macdSeries.length >= 9
    ? calcEMA(macdSeries.slice(-9).map(v => ({ close: v })), 9)
    : macdLine;
  return { macdLine, signalLine, histogram: macdLine - signalLine };
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  let trSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const cur = candles[i], prev = candles[i - 1];
    trSum += Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
  }
  return trSum / period;
}

function calcADX(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  let trSum = 0, plusDMSum = 0, minusDMSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const cur = candles[i], prev = candles[i - 1];
    const tr = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
    const upMove = cur.high - prev.high;
    const downMove = prev.low - cur.low;
    const plusDM = (upMove > downMove && upMove > 0) ? upMove : 0;
    const minusDM = (downMove > upMove && downMove > 0) ? downMove : 0;
    trSum += tr; plusDMSum += plusDM; minusDMSum += minusDM;
  }
  if (trSum === 0) return 0;
  const plusDI = (plusDMSum / trSum) * 100;
  const minusDI = (minusDMSum / trSum) * 100;
  const diDiff = Math.abs(plusDI - minusDI);
  const diSum = plusDI + minusDI;
  return diSum === 0 ? 0 : (diDiff / diSum) * 100;
}

// ─────────────────────────────────────────────
// 📊 Trend Layer — EMA 20/50/100 Alignment
// ─────────────────────────────────────────────
function analyzeTrend(candles) {
  const ema20 = calcEMA(candles, 20);
  const ema50 = calcEMA(candles, 50);
  const ema100 = candles.length >= 100 ? calcEMA(candles, 100) : ema50;
  const lastClose = candles[candles.length - 1].close;

  const bullAligned = ema20 > ema50 && ema50 > ema100 && lastClose > ema20;
  const bearAligned = ema20 < ema50 && ema50 < ema100 && lastClose < ema20;

  let direction = 'NEUTRAL', strength = 0;
  if (bullAligned) { direction = 'UP'; strength = 1; }
  else if (bearAligned) { direction = 'DOWN'; strength = 1; }
  else if (ema20 > ema50 && lastClose > ema20) { direction = 'UP'; strength = 0.6; }
  else if (ema20 < ema50 && lastClose < ema20) { direction = 'DOWN'; strength = 0.6; }
  else if (ema20 > ema50) { direction = 'UP'; strength = 0.3; }
  else if (ema20 < ema50) { direction = 'DOWN'; strength = 0.3; }

  return { direction, strength, ema20, ema50, ema100 };
}

// ─────────────────────────────────────────────
// 🏗️ Market Structure — Swing High/Low, BOS, CHOCH
// ─────────────────────────────────────────────
function findSwings(candles, lookback = 2) {
  const highs = [], lows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    let isHigh = true, isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= c.high) isHigh = false;
      if (candles[j].low <= c.low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: c.high });
    if (isLow) lows.push({ index: i, price: c.low });
  }
  return { highs, lows };
}

function analyzeStructure(candles) {
  const { highs, lows } = findSwings(candles, 2);
  const lastClose = candles[candles.length - 1].close;

  if (highs.length < 2 || lows.length < 2) return { structure: 'UNCLEAR', direction: 'NEUTRAL', strength: 0 };

  const [h1, h2] = highs.slice(-2);
  const [l1, l2] = lows.slice(-2);
  const higherHigh = h2.price > h1.price, higherLow = l2.price > l1.price;
  const lowerHigh = h2.price < h1.price, lowerLow = l2.price < l1.price;

  const recentSwingHigh = highs[highs.length - 1].price;
  const recentSwingLow = lows[lows.length - 1].price;

  const bosUp = higherHigh && higherLow && lastClose > recentSwingHigh;
  const bosDown = lowerHigh && lowerLow && lastClose < recentSwingLow;
  const chochUp = lowerHigh && lowerLow && lastClose > recentSwingHigh;
  const chochDown = higherHigh && higherLow && lastClose < recentSwingLow;

  if (bosUp) return { structure: 'BOS_UP', direction: 'UP', strength: 1 };
  if (bosDown) return { structure: 'BOS_DOWN', direction: 'DOWN', strength: 1 };
  if (chochUp) return { structure: 'CHOCH_UP', direction: 'UP', strength: 0.8 };
  if (chochDown) return { structure: 'CHOCH_DOWN', direction: 'DOWN', strength: 0.8 };
  if (higherHigh && higherLow) return { structure: 'UPTREND', direction: 'UP', strength: 0.5 };
  if (lowerHigh && lowerLow) return { structure: 'DOWNTREND', direction: 'DOWN', strength: 0.5 };
  return { structure: 'RANGING', direction: 'NEUTRAL', strength: 0 };
}

// ─────────────────────────────────────────────
// 🧱 Support / Resistance Zone
// ─────────────────────────────────────────────
function analyzeSR(candles) {
  const { highs, lows } = findSwings(candles, 2);
  const lastClose = candles[candles.length - 1].close;
  const recentRange = candles.slice(-30);
  const rangeHigh = Math.max(...recentRange.map(c => c.high));
  const rangeLow = Math.min(...recentRange.map(c => c.low));
  const zoneTolerance = (rangeHigh - rangeLow) * 0.08;

  const resistances = highs.map(h => h.price).filter(p => p > lastClose);
  const supports = lows.map(l => l.price).filter(p => p < lastClose);
  const nearestResistance = resistances.length ? Math.min(...resistances) : null;
  const nearestSupport = supports.length ? Math.max(...supports) : null;

  let direction = 'NEUTRAL', strength = 0, note = 'No clear zone';
  if (nearestSupport !== null && Math.abs(lastClose - nearestSupport) <= zoneTolerance) {
    direction = 'UP'; strength = 0.7; note = 'Near Support (bounce likely)';
  } else if (nearestResistance !== null && Math.abs(lastClose - nearestResistance) <= zoneTolerance) {
    direction = 'DOWN'; strength = 0.7; note = 'Near Resistance (rejection likely)';
  }
  return { direction, strength, note, nearestSupport, nearestResistance };
}

// ─────────────────────────────────────────────
// 🕯️ Candlestick Layer (Expanded)
// ─────────────────────────────────────────────
function analyzeCandlestick(candles) {
  const len = candles.length;
  const c = candles[len - 1], p = candles[len - 2], p2 = candles[len - 3];
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low || 0.00001;
  const upperWick = c.high - Math.max(c.close, c.open);
  const lowerWick = Math.min(c.close, c.open) - c.low;
  const isBullish = c.close > c.open, isBearish = c.close < c.open;

  if (body / range > 0.9)
    return { pattern: isBullish ? 'Bullish Marubozu' : 'Bearish Marubozu', direction: isBullish ? 'UP' : 'DOWN', strength: 0.7 };
  if (isBullish && p.close < p.open && c.close > p.open && c.open < p.close)
    return { pattern: 'Bullish Engulfing', direction: 'UP', strength: 1 };
  if (isBearish && p.close > p.open && c.open > p.close && c.close < p.open)
    return { pattern: 'Bearish Engulfing', direction: 'DOWN', strength: 1 };

  const recentLow = Math.min(...candles.slice(-10).map(x => x.low));
  const recentHigh = Math.max(...candles.slice(-10).map(x => x.high));
  if (lowerWick > body * 2 && upperWick < body * 0.5 && c.low <= recentLow * 1.001)
    return { pattern: 'Hammer', direction: 'UP', strength: 0.85 };
  if (upperWick > body * 2 && lowerWick < body * 0.5 && c.high >= recentHigh * 0.999)
    return { pattern: 'Shooting Star', direction: 'DOWN', strength: 0.85 };
  if (lowerWick > body * 2 && upperWick < body * 0.5)
    return { pattern: 'Bullish Pin Bar', direction: 'UP', strength: 0.75 };
  if (upperWick > body * 2 && lowerWick < body * 0.5)
    return { pattern: 'Bearish Pin Bar', direction: 'DOWN', strength: 0.75 };

  const firstBig = Math.abs(p2.close - p2.open) > range * 0.5;
  const midSmall = Math.abs(p.close - p.open) < Math.abs(p2.close - p2.open) * 0.4;
  if (p2.close < p2.open && firstBig && midSmall && isBullish && c.close > (p2.open + p2.close) / 2)
    return { pattern: 'Morning Star', direction: 'UP', strength: 0.9 };
  if (p2.close > p2.open && firstBig && midSmall && isBearish && c.close < (p2.open + p2.close) / 2)
    return { pattern: 'Evening Star', direction: 'DOWN', strength: 0.9 };

  if (c.high < p.high && c.low > p.low) return { pattern: 'Inside Bar', direction: 'NEUTRAL', strength: 0 };
  if (c.high > p.high && c.low < p.low)
    return { pattern: isBullish ? 'Bullish Outside Bar' : 'Bearish Outside Bar', direction: isBullish ? 'UP' : 'DOWN', strength: 0.5 };
  if (body < range * 0.1) return { pattern: 'Doji', direction: 'NEUTRAL', strength: 0 };

  return { pattern: 'No Clear Pattern', direction: 'NEUTRAL', strength: 0 };
}

// ─────────────────────────────────────────────
// 🌀 Momentum — RSI + MACD + Divergence
// ─────────────────────────────────────────────
function detectDivergence(candles, rsiSeries) {
  if (rsiSeries.length < 10) return null;
  const n = Math.min(15, rsiSeries.length);
  const priceSlice = candles.slice(-n).map(c => c.close);
  const rsiSlice = rsiSeries.slice(-n);
  const half = Math.floor(n / 2);

  const minIdx1 = priceSlice.slice(0, half).indexOf(Math.min(...priceSlice.slice(0, half)));
  const minIdx2 = half + priceSlice.slice(half).indexOf(Math.min(...priceSlice.slice(half)));
  if (priceSlice[minIdx2] < priceSlice[minIdx1] && rsiSlice[minIdx2] > rsiSlice[minIdx1])
    return { type: 'BULLISH_REGULAR', direction: 'UP' };

  const maxIdx1 = priceSlice.slice(0, half).indexOf(Math.max(...priceSlice.slice(0, half)));
  const maxIdx2 = half + priceSlice.slice(half).indexOf(Math.max(...priceSlice.slice(half)));
  if (priceSlice[maxIdx2] > priceSlice[maxIdx1] && rsiSlice[maxIdx2] < rsiSlice[maxIdx1])
    return { type: 'BEARISH_REGULAR', direction: 'DOWN' };

  return null;
}

function analyzeMomentum(candles) {
  const rsi = calcRSI(candles);
  const macd = calcMACD(candles);
  const rsiSeries = calcRSISeries(candles);
  const divergence = detectDivergence(candles, rsiSeries);

  let direction = 'NEUTRAL', strength = 0;
  if (rsi < 30) { direction = 'UP'; strength = 0.8; }
  else if (rsi > 70) { direction = 'DOWN'; strength = 0.8; }
  else if (rsi < 45) { direction = 'UP'; strength = 0.4; }
  else if (rsi > 55) { direction = 'DOWN'; strength = 0.4; }

  const macdDir = macd.histogram > 0 ? 'UP' : macd.histogram < 0 ? 'DOWN' : 'NEUTRAL';
  const macdStrength = Math.min(1, Math.abs(macd.histogram) * 5000);

  let combinedDirection = direction, combinedStrength = strength;
  if (macdDir !== 'NEUTRAL') {
    if (macdDir === direction) combinedStrength = Math.min(1, (strength + macdStrength) / 1.3);
    else if (direction === 'NEUTRAL') { combinedDirection = macdDir; combinedStrength = macdStrength * 0.7; }
    else combinedStrength = Math.max(0, strength - macdStrength * 0.5);
  }

  if (divergence) { combinedDirection = divergence.direction; combinedStrength = Math.max(combinedStrength, 0.85); }

  return { direction: combinedDirection, strength: combinedStrength, rsi, macdHistogram: macd.histogram, divergence: divergence ? divergence.type : null };
}

// ─────────────────────────────────────────────
// 💧 Liquidity Sweep + Session + Volatility (Volume-proxy)
// ─────────────────────────────────────────────
function analyzeLiquidity(candles) {
  const c = candles[candles.length - 1];
  const recent = candles.slice(-15, -1);
  const recentHigh = Math.max(...recent.map(x => x.high));
  const recentLow = Math.min(...recent.map(x => x.low));

  const sweptHigh = c.high > recentHigh && c.close < recentHigh;
  const sweptLow = c.low < recentLow && c.close > recentLow;

  if (sweptLow) return { direction: 'UP', strength: 0.8, note: 'Liquidity Sweep Low (Stop Hunt) → Reversal Up' };
  if (sweptHigh) return { direction: 'DOWN', strength: 0.8, note: 'Liquidity Sweep High (Stop Hunt) → Reversal Down' };
  return { direction: 'NEUTRAL', strength: 0, note: 'No Sweep Detected' };
}

function getSession() {
  const h = new Date().getUTCHours();
  const tokyo = h >= 0 && h < 9, london = h >= 7 && h < 16, newyork = h >= 12 && h < 21;
  const overlap = london && newyork;
  let name = 'Off-Session (Low Liquidity)';
  if (overlap) name = 'London-NewYork Overlap (High Liquidity)';
  else if (london) name = 'London Session';
  else if (newyork) name = 'New York Session';
  else if (tokyo) name = 'Tokyo Session';
  return { name, tokyo, london, newyork, overlap };
}

// ⚠️ Forex-এ TwelveData থেকে reliable real "volume" আসে না (decentralized market) —
// তাই ATR-ভিত্তিক volatility expansion/compression কে volume-এর বিকল্প (proxy) হিসেবে ব্যবহার হচ্ছে
function analyzeVolatility(candles) {
  const atr = calcATR(candles);
  const atrSeries = [];
  for (let i = 20; i <= candles.length; i += 5) atrSeries.push(calcATR(candles.slice(0, i)));
  const avgATR = atrSeries.length ? atrSeries.reduce((a, b) => a + b, 0) / atrSeries.length : atr;
  return { atr, avgATR, expansion: atr > avgATR * 1.15, compression: atr < avgATR * 0.75 };
}

function analyzeCandleQuality(candles) {
  const c = candles[candles.length - 1];
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low || 0.00001;
  const bodyRatio = body / range;
  const isImpulse = bodyRatio > 0.6;
  const isExhaustion = bodyRatio < 0.25 &&
    (c.high - Math.max(c.close, c.open) > body) && (Math.min(c.close, c.open) - c.low > body);
  return { bodyRatio, isImpulse, isExhaustion, quality: isImpulse ? 'Strong' : (isExhaustion ? 'Exhaustion' : 'Weak') };
}

// ─────────────────────────────────────────────
// 🧮 Weighted Confidence Score (Total = 100)
// ─────────────────────────────────────────────
const WEIGHTS = { trend: 20, structure: 20, sr: 10, candlestick: 15, momentum: 15, liquidity: 20 };

function scoreSetup(candles) {
  const trend = analyzeTrend(candles);
  const structure = analyzeStructure(candles);
  const sr = analyzeSR(candles);
  const pattern = analyzeCandlestick(candles);
  const momentum = analyzeMomentum(candles);
  const liquidity = analyzeLiquidity(candles);
  const volatility = analyzeVolatility(candles);
  const quality = analyzeCandleQuality(candles);
  const session = getSession();

  let upScore = 0, downScore = 0;
  function apply(layer, weight) {
    if (layer.direction === 'UP') upScore += weight * layer.strength;
    else if (layer.direction === 'DOWN') downScore += weight * layer.strength;
  }
  apply(trend, WEIGHTS.trend);
  apply(structure, WEIGHTS.structure);
  apply(sr, WEIGHTS.sr);
  apply({ direction: pattern.direction, strength: pattern.strength }, WEIGHTS.candlestick);
  apply(momentum, WEIGHTS.momentum);
  apply(liquidity, WEIGHTS.liquidity);

  // 🚫 Entry Filter — শুধু একদম দুর্বল সেটআপ hard-reject (sideways/exhaustion/off-session)
  const rejectReasons = [];
  if (volatility.compression && structure.structure === 'RANGING') rejectReasons.push('SIDEWAYS_MARKET');
  if (quality.isExhaustion) rejectReasons.push('EXHAUSTION_CANDLE');
  if (!session.london && !session.newyork && !session.tokyo) rejectReasons.push('OFF_SESSION');

  const direction = upScore >= downScore ? 'UP' : 'DOWN';
  const confidence = Math.max(upScore, downScore); // ✅ ১০০-পয়েন্ট স্কেলে সরাসরি স্কোর, ভুয়া "agreement ratio" না

  return {
    direction, confidence, rejectReasons,
    detail: { trend, structure, sr, pattern, momentum, liquidity, volatility, quality, session, rsi: momentum.rsi, adx: calcADX(candles) },
  };
}

// ⚠️ MIN_CONFIDENCE — এখন সত্যিকারের ১০০-স্কেলে; সাধারণত 65-80 রেঞ্জেই ভালো ব্যালেন্স হয়
// বেশি বাড়ালে সিগনাল কম আসবে (skip বেশি), কমালে accuracy কমতে পারে — টেস্ট করে টিউন করুন
const MIN_CONFIDENCE = 70;

async function analyze(symbol) {
  if (!isRealMarketOpen()) return { signal: false, reason: 'MARKET_CLOSED' };

  const [m1, m5] = await Promise.all([
    twelveData.getTimeSeries(symbol, '1min', 60),
    twelveData.getTimeSeries(symbol, '5min', 60),
  ]);

  const toCandles = (data) => data.values.map(v => ({
    open: parseFloat(v.open), high: parseFloat(v.high), low: parseFloat(v.low), close: parseFloat(v.close), datetime: v.datetime,
  })).reverse();

  const candles1m = toCandles(m1);
  const candles5m = toCandles(m5);
  if (candles1m.length < 30) return { signal: false, reason: 'NOT_ENOUGH_DATA' };

  const score1m = scoreSetup(candles1m);
  const score5m = scoreSetup(candles5m);

  let finalConfidence = score1m.confidence;
  if (score5m.direction === score1m.direction) {
    finalConfidence = Math.min(100, score1m.confidence + score5m.confidence * 0.15);
  } else {
    finalConfidence = Math.max(0, score1m.confidence - score5m.confidence * 0.15);
  }

  if (score1m.rejectReasons.length > 0) return { signal: false, reason: score1m.rejectReasons[0] };
  if (finalConfidence < MIN_CONFIDENCE) return { signal: false, reason: 'LOW_CONFIDENCE' };

  return {
    signal: true,
    direction: score1m.direction === 'UP' ? 'UP⏫' : 'DOWN⏬',
    confidencePct: Math.round(Math.min(99, finalConfidence)),
    symbol,
    detail: {
      m1Agreement: score1m.confidence.toFixed(1),
      m5Agreement: score5m.confidence.toFixed(1),
      adx: score1m.detail.adx.toFixed(1),
      rsi: score1m.detail.rsi.toFixed(1),
      pattern: score1m.detail.pattern.pattern,
      structure: score1m.detail.structure.structure,
      session: score1m.detail.session.name,
    },
  };
}

module.exports = {
  analyze, isRealMarketOpen, scoreSetup,
  calcRSI, calcEMA, calcMACD, calcADX, calcATR,
  analyzeTrend, analyzeStructure, analyzeSR, analyzeCandlestick, analyzeMomentum, analyzeLiquidity,
};
