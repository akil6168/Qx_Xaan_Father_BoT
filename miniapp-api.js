const crypto = require('crypto');
const https = require('https');

const ADMIN_ID = 5724602667;
const REGISTRATION_CHANNEL_ID = '-1002368787439';

// ====== Init Data Validation ======
function validateInitData(initData, botToken) {
  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get('hash');
  if (!hash) return null;
  urlParams.delete('hash');
  const dataCheckArr = [];
  for (const [key, value] of [...urlParams.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    dataCheckArr.push(`${key}=${value}`);
  }
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckArr.join('\n')).digest('hex');
  if (computedHash !== hash) return null;
  const authDate = parseInt(urlParams.get('auth_date') || '0', 10);
  if (Math.floor(Date.now() / 1000) - authDate > 86400) return null;
  const userStr = urlParams.get('user');
  if (!userStr) return null;
  return JSON.parse(userStr);
}

// ====== Smart Image Processor ======
async function processScreenshot(imageBase64) {
  try {
    const sharp = require('sharp');
    const inputBuffer = Buffer.from(imageBase64, 'base64');
    const meta = await sharp(inputBuffer).metadata();
    const { width, height } = meta;

    console.log(`📐 Screenshot: ${width}x${height}px, ${Math.round(inputBuffer.length/1024)}KB`);

    // Smart crop — Top 20% (balance/status) + Bottom 30% (buttons) কাটো
    const topCrop    = Math.round(height * 0.20);
    const bottomCrop = Math.round(height * 0.30);
    const cropHeight = height - topCrop - bottomCrop;

    if (cropHeight < 100 || width < 100) {
      console.log('⚠️ Too small, compress only');
      const c = await sharp(inputBuffer).resize({ width: 900, withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
      return c.toString('base64');
    }

    const cropped = await sharp(inputBuffer)
      .extract({ left: 0, top: topCrop, width, height: cropHeight })
      .resize({ width: 900, withoutEnlargement: true })
      .jpeg({ quality: 78 })
      .toBuffer();

    console.log(`✅ Cropped+Compressed: ${Math.round(cropped.length/1024)}KB (was ${Math.round(inputBuffer.length/1024)}KB)`);
    return cropped.toString('base64');

  } catch (e) {
    console.error('⚠️ sharp error:', e.message, '— using original');
    return imageBase64;
  }
}

// ====== Gemini Analysis ======
const geminiKeyPool = require('./geminikey');
const GEMINI_MODELS = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-flash-latest'];
const MIN_SCORE_GAP = 20;

const ANALYSIS_PROMPT = `STEP 1 - CHART VERIFICATION:
Is this a trading candlestick/price chart? If NOT, reply exactly: NOT_A_CHART

STEP 2 - VISIBLE-ONLY ANALYSIS:
Analyze ONLY what is visibly present. Never assume hidden indicators.

STEP 3 - MULTI-CONFIRMATION:
Find: Market Structure, Smart Money Concepts, Support/Resistance, Candlestick Quality, Momentum, Entry Quality.

STEP 4 - WEIGHTED SCORING:
MARKET STRUCTURE 30%, SMC 25%, S&R 15%, CANDLES 15%, MOMENTUM 10%, ENTRY 5%.

STEP 5 - DECISION:
Compute BULLISH_SCORE and BEARISH_SCORE (0-100 each, independently).
Gap >= ${MIN_SCORE_GAP} → BUY or SELL. Gap < ${MIN_SCORE_GAP} → NO_TRADE.

WIN PROBABILITY: Gap ${MIN_SCORE_GAP}-35 = 65-70%, Gap 36-55 = 75-80%, Gap 56+ = 85%.

Reply ONLY in this exact format, no extra text:
DIRECTION: BUY or SELL or NO_TRADE
BULLISH_SCORE: (0-100)
BEARISH_SCORE: (0-100)
CONFIDENCE: Medium or High or Very High
WIN_PROBABILITY: 65% to 85%
TREND: (4 words)
SETUP_QUALITY: A+ or A or B
REASON: (checkmarked confirmations, single line)`;

function callGemini(model, apiKey, imageBase64) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      contents: [{ parts: [
        { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } },
        { text: ANALYSIS_PROMPT }
      ]}],
      generationConfig: { temperature: 0.1, maxOutputTokens: 1024 }
    });
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${model}:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const text = JSON.parse(data)?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          resolve(text.length > 10 ? { ok: true, text } : { ok: false, error: 'empty' });
        } catch (e) { resolve({ ok: false, error: e.message }); }
      });
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.setTimeout(35000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(body); req.end();
  });
}

async function analyzeWithGemini(imageBase64) {
  const keys = geminiKeyPool.getAllKeys ? geminiKeyPool.getAllKeys() : [];
  if (!keys.length) throw new Error('No Gemini keys');
  for (const model of GEMINI_MODELS) {
    for (const key of keys) {
      const r = await callGemini(model, key, imageBase64);
      if (r.ok) return r.text;
    }
  }
  throw new Error('All Gemini models failed');
}

function parseGeminiResult(text) {
  if (!text) return null;
  if (text.trim() === 'NOT_A_CHART') return { notAChart: true };
  const get = k => { const m = text.match(new RegExp(`${k}:\\s*(.+)`)); return m ? m[1].trim() : null; };
  const direction = get('DIRECTION');
  if (!direction) return null;
  if (direction === 'NO_TRADE') return { noTrade: true };
  const confNum = parseInt(get('WIN_PROBABILITY') || '70') || 70;
  return {
    direction: direction === 'BUY' ? 'CALL' : 'PUT',
    confidence: confNum,
    trend: get('TREND') || 'Unknown',
    pattern: get('SETUP_QUALITY') || 'B',
    analysis: get('REASON') || '',
    bullishScore: parseInt(get('BULLISH_SCORE') || '0'),
    bearishScore: parseInt(get('BEARISH_SCORE') || '0'),
    confidenceLabel: get('CONFIDENCE') || 'Medium',
    bullish_indicators: direction === 'BUY' ? ['Strong Structure', 'Bullish Momentum'] : [],
    bearish_indicators: direction !== 'BUY' ? ['Bearish Structure', 'Selling Pressure'] : [],
  };
}

// ====== News Prediction ======
function generateNewsPrediction(event) {
  const forecast = parseFloat(event.forecast);
  const previous = parseFloat(event.previous);
  if (isNaN(forecast) || isNaN(previous)) {
    return { direction: 'NEUTRAL', reason: 'Data অপ্রতুল। News release এর পর chart দেখুন।', pairs: [] };
  }
  const currency = event.currency || event.country || 'USD';
  const isPositive = forecast > previous;
  const diff = Math.abs(forecast - previous);
  const pctDiff = previous !== 0 ? (diff / Math.abs(previous)) * 100 : 0;
  const strength = pctDiff > 10 ? 'Strong' : pctDiff > 3 ? 'Moderate' : 'Weak';
  const pairMap = {
    USD: ['EUR/USD','GBP/USD','USD/JPY'], EUR: ['EUR/USD','EUR/GBP','EUR/JPY'],
    GBP: ['GBP/USD','EUR/GBP','GBP/JPY'], JPY: ['USD/JPY','EUR/JPY','GBP/JPY'],
    AUD: ['AUD/USD','AUD/JPY'], CAD: ['USD/CAD','CAD/JPY'],
    CHF: ['USD/CHF','EUR/CHF'], NZD: ['NZD/USD','NZD/JPY'],
  };
  return {
    direction: isPositive ? 'UP' : 'DOWN',
    reason: `${currency}: Forecast ${event.forecast} vs Previous ${event.previous} — ${strength} ${isPositive ? 'positive' : 'negative'} surprise। ${currency} pair এ ${isPositive ? 'bullish' : 'bearish'} move সম্ভব।`,
    pairs: pairMap[currency] || [],
  };
}

// ====== Register All Routes ======
function registerMiniAppRoutes(app, {
  getDb, approvedUsers, bannedUsers, submissions,
  isApproved, getMiniappTrialLeft, incrementMiniappTrial,
  MINIAPP_FREE_TRIAL, bot, getCachedNews
}) {
  const express = require('express');

  // ✅ 50MB limit for image uploads
  app.use('/miniapp', express.json({ limit: '50mb' }));
  app.use('/miniapp', express.urlencoded({ limit: '50mb', extended: true }));

  // CORS
  app.use('/miniapp', (req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

  const { addScanRoute } = require('./miniapp-scan-route');
  addScanRoute(app, { getDb, approvedUsers, bannedUsers, validateInitData, isApproved, getMiniappTrialLeft, incrementMiniappTrial, MINIAPP_FREE_TRIAL });

  // ====== /miniapp/verify ======
  app.post('/miniapp/verify', async (req, res) => {
    try {
      const { initData } = req.body;
      if (!initData) return res.status(400).json({ verified: false, error: 'initData missing' });
      const tgUser = validateInitData(initData, process.env.BOT_TOKEN);
      if (!tgUser) return res.status(401).json({ verified: false, error: 'invalid initData' });
      const userId = tgUser.id;
      if (bannedUsers.has(userId)) return res.status(403).json({ verified: false, banned: true });
      const isAdmin = userId === ADMIN_ID;
      const approved = isAdmin || (typeof isApproved === 'function' ? isApproved(userId) : approvedUsers.has(userId));
      const trialLeft = approved ? null : (getMiniappTrialLeft ? getMiniappTrialLeft(userId) : 0);
      const verified = approved || (trialLeft !== null && trialLeft > 0);
      const sub = submissions.find(s => s.userId === userId);
      return res.json({
        verified, isAdmin, isApproved: approved,
        trialLeft, trialTotal: approved ? null : (MINIAPP_FREE_TRIAL || 0),
        userId, firstName: tgUser.first_name || null,
        traderId: sub ? sub.traderId : null,
      });
    } catch (e) {
      console.error('verify error:', e.message);
      return res.status(500).json({ verified: false, error: 'server error' });
    }
  });

  // ====== /miniapp/screenshot-analyze ======
  app.post('/miniapp/screenshot-analyze', async (req, res) => {
    try {
      const { initData, imageBase64 } = req.body;
      if (!initData || !imageBase64) return res.status(400).json({ ok: false, error: 'Missing data' });

      const tgUser = validateInitData(initData, process.env.BOT_TOKEN);
      if (!tgUser) return res.status(401).json({ ok: false, error: 'Invalid initData' });

      const userId = tgUser.id;
      if (bannedUsers.has(userId)) return res.status(403).json({ ok: false, error: 'Banned' });

      const isAdmin = userId === ADMIN_ID;
      const approved = isAdmin || (typeof isApproved === 'function' ? isApproved(userId) : approvedUsers.has(userId));

      // Trial check
      if (!approved) {
        const trialLeft = getMiniappTrialLeft ? getMiniappTrialLeft(userId) : 0;
        if (trialLeft <= 0) return res.json({ ok: false, reason: 'TRIAL_EXHAUSTED' });
        if (incrementMiniappTrial) incrementMiniappTrial(userId);
      }

      // ✅ Smart crop + compress
      const processedBase64 = await processScreenshot(imageBase64);

      // Gemini analyze
      const rawText = await analyzeWithGemini(processedBase64);
      const result = parseGeminiResult(rawText);

      if (!result) return res.json({ ok: false, error: 'Analysis failed' });
      if (result.notAChart) return res.json({ ok: false, notAChart: true, error: 'এটি chart নয়। Quotex chart screenshot দিন।' });
      if (result.noTrade) return res.json({ ok: true, noTrade: true });

      // MongoDB stats
      const db = getDb ? getDb() : null;
      if (db) {
        db.collection('userStats').updateOne({ userId }, {
          $inc: { totalScreenshots: 1, miniappScans: 1 },
          $set: { lastActive: new Date() }
        }, { upsert: true }).catch(e => console.log('stats error:', e.message));
      }

      return res.json({ ok: true, result });
    } catch (e) {
      console.error('screenshot-analyze error:', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ====== /miniapp/news ======
  app.get('/miniapp/news', async (req, res) => {
    try {
      const rawNews = getCachedNews ? getCachedNews() : [];
      const events = rawNews
        .filter(n => n.impact === 'High' || n.impact === 'Medium')
        .slice(0, 15)
        .map(n => ({
          title: n.title || n.event || 'Economic Event',
          currency: n.currency || n.country || 'USD',
          impact: n.impact || 'Medium',
          time: n.date || n.time || new Date().toISOString(),
          forecast: n.forecast || null,
          previous: n.previous || null,
          actual: n.actual || null,
          prediction: generateNewsPrediction(n),
        }));
      return res.json({ ok: true, events });
    } catch (e) {
      console.error('news error:', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ====== /miniapp/profile ======
  app.post('/miniapp/profile', async (req, res) => {
    try {
      const { initData } = req.body;
      if (!initData) return res.status(400).json({ ok: false, error: 'Missing initData' });
      const tgUser = validateInitData(initData, process.env.BOT_TOKEN);
      if (!tgUser) return res.status(401).json({ ok: false, error: 'Invalid initData' });
      const userId = tgUser.id;
      const db = getDb ? getDb() : null;
      let stats = { totalSignals: 0, totalScreenshots: 0, miniappScans: 0, lastActiveFmt: null };
      if (db) {
        const s = await db.collection('userStats').findOne({ userId });
        if (s) {
          stats.totalSignals = s.totalSignals || 0;
          stats.totalScreenshots = s.totalScreenshots || 0;
          stats.miniappScans = s.miniappScans || 0;
          if (s.lastActive) {
            const bd = new Date(new Date(s.lastActive).getTime() + 6*60*60*1000);
            stats.lastActiveFmt = `${String(bd.getUTCHours()).padStart(2,'0')}:${String(bd.getUTCMinutes()).padStart(2,'0')} BD`;
          }
        }
      }
      return res.json({ ok: true, stats });
    } catch (e) {
      console.error('profile error:', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  });
}

module.exports = { registerMiniAppRoutes, validateInitData };
