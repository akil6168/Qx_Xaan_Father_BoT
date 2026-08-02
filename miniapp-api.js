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
  const dataCheckString = dataCheckArr.join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (computedHash !== hash) return null;

  const authDate = parseInt(urlParams.get('auth_date') || '0', 10);
  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  if (ageSeconds > 86400) return null;

  const userStr = urlParams.get('user');
  if (!userStr) return null;
  return JSON.parse(userStr);
}

// ====== Image Compress (base64 → smaller base64) ======
// sharp ছাড়াই — buffer resize করে quality কমায়
async function compressImageBase64(base64Input) {
  try {
    // Max ~800KB after compress
    const inputBuffer = Buffer.from(base64Input, 'base64');
    const inputSizeKB = inputBuffer.length / 1024;

    // যদি 500KB এর নিচে থাকে তাহলে compress দরকার নেই
    if (inputSizeKB < 500) return base64Input;

    // sharp থাকলে ব্যবহার করো
    try {
      const sharp = require('sharp');
      const compressed = await sharp(inputBuffer)
        .resize({ width: 1024, withoutEnlargement: true })
        .jpeg({ quality: 70 })
        .toBuffer();
      console.log(`📸 Image compressed: ${Math.round(inputSizeKB)}KB → ${Math.round(compressed.length/1024)}KB`);
      return compressed.toString('base64');
    } catch (sharpErr) {
      // sharp না থাকলে raw buffer এর প্রথম 800KB পাঠাও
      console.log('⚠️ sharp not available, using raw image');
      if (inputSizeKB > 3000) {
        // অনেক বড় হলে truncate করো (জরুরি fallback)
        const maxBytes = 800 * 1024;
        const truncated = inputBuffer.slice(0, maxBytes);
        return truncated.toString('base64');
      }
      return base64Input;
    }
  } catch (e) {
    console.error('compress error:', e.message);
    return base64Input;
  }
}

// ====== Gemini Screenshot Analysis ======
const geminiKeyPool = require('./geminikey');

const GEMINI_MODELS = [
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-flash-latest',
];

const MIN_SCORE_GAP = 20;

const ANALYSIS_PROMPT = `STEP 1 - CHART VERIFICATION:
Is this a trading candlestick/price chart? If NOT a chart, reply exactly: NOT_A_CHART

STEP 2 - VISIBLE-ONLY ANALYSIS:
Analyze ONLY what is visibly present. Never assume hidden indicators.

STEP 3 - MULTI-CONFIRMATION:
Find: Market Structure, Smart Money Concepts, Support/Resistance, Candlestick Quality, Momentum, Entry Quality.

STEP 4 - WEIGHTED SCORING:
MARKET STRUCTURE 30%, SMC 25%, S&R 15%, CANDLES 15%, MOMENTUM 10%, ENTRY 5%.

STEP 5 - DECISION:
BULLISH_SCORE vs BEARISH_SCORE (0-100 each).
Gap >= ${MIN_SCORE_GAP} → BUY or SELL. Gap < ${MIN_SCORE_GAP} → NO_TRADE.

WIN PROBABILITY: Gap ${MIN_SCORE_GAP}-35 = 65-70%, Gap 36-55 = 75-80%, Gap 56+ = 85%.

Reply ONLY in this exact format:
DIRECTION: BUY or SELL or NO_TRADE
BULLISH_SCORE: (0-100)
BEARISH_SCORE: (0-100)
CONFIDENCE: Medium or High or Very High
WIN_PROBABILITY: 65% to 85%
TREND: (4 words)
SETUP_QUALITY: A+ or A or B
REASON: (checkmarked confirmations)`;

function callGeminiModel(model, apiKey, imageBase64) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } },
          { text: ANALYSIS_PROMPT }
        ]
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 1024 }
    });

    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${model}:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          if (text && text.length > 10) resolve({ ok: true, text });
          else resolve({ ok: false, error: 'empty response' });
        } catch (e) {
          resolve({ ok: false, error: e.message });
        }
      });
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.setTimeout(35000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

async function analyzeScreenshot(imageBase64) {
  const allKeys = geminiKeyPool.getAllKeys ? geminiKeyPool.getAllKeys() : [];
  if (!allKeys || allKeys.length === 0) throw new Error('No Gemini keys');

  for (const model of GEMINI_MODELS) {
    for (const key of allKeys) {
      const result = await callGeminiModel(model, key, imageBase64);
      if (result.ok) return result.text;
    }
  }
  throw new Error('All Gemini models/keys failed');
}

function parseResult(text) {
  if (!text) return null;
  if (text.trim() === 'NOT_A_CHART') return { notAChart: true };

  const get = (key) => {
    const m = text.match(new RegExp(`${key}:\\s*(.+)`));
    return m ? m[1].trim() : null;
  };

  const direction = get('DIRECTION');
  if (!direction) return null;
  if (direction === 'NO_TRADE') return { noTrade: true };

  const winProb = get('WIN_PROBABILITY') || '70%';
  const confNum = parseInt(winProb) || 70;

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
    return { direction: 'NEUTRAL', reason: 'Forecast/Previous data নেই। News release এর পর chart দেখুন।', pairs: [] };
  }

  const currency = event.currency || event.country || 'USD';
  const isPositive = forecast > previous;
  const diff = Math.abs(forecast - previous);
  const pctDiff = previous !== 0 ? (diff / Math.abs(previous)) * 100 : 0;
  const strength = pctDiff > 10 ? 'Strong' : pctDiff > 3 ? 'Moderate' : 'Weak';

  const pairMap = {
    USD: ['EUR/USD', 'GBP/USD', 'USD/JPY'],
    EUR: ['EUR/USD', 'EUR/GBP', 'EUR/JPY'],
    GBP: ['GBP/USD', 'EUR/GBP', 'GBP/JPY'],
    JPY: ['USD/JPY', 'EUR/JPY', 'GBP/JPY'],
    AUD: ['AUD/USD', 'AUD/JPY'],
    CAD: ['USD/CAD', 'CAD/JPY'],
    CHF: ['USD/CHF', 'EUR/CHF'],
    NZD: ['NZD/USD', 'NZD/JPY'],
  };

  return {
    direction: isPositive ? 'UP' : 'DOWN',
    reason: `${currency}: Forecast ${event.forecast} vs Previous ${event.previous} — ${strength} ${isPositive ? 'positive' : 'negative'} surprise. ${currency} pair এ ${isPositive ? 'bullish' : 'bearish'} move সম্ভব।`,
    pairs: pairMap[currency] || [],
  };
}

// ====== Register Routes ======
function registerMiniAppRoutes(app, {
  getDb, approvedUsers, bannedUsers, submissions,
  isApproved, getMiniappTrialLeft, incrementMiniappTrial,
  MINIAPP_FREE_TRIAL, bot, getCachedNews
}) {
  const express = require('express');

  // ✅ Fix: 50mb limit globally for miniapp routes
  app.use('/miniapp', express.json({ limit: '50mb' }));
  app.use('/miniapp', express.urlencoded({ limit: '50mb', extended: true }));

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

      // ✅ Compress image before sending to Gemini
      const compressedBase64 = await compressImageBase64(imageBase64);

      const rawText = await analyzeScreenshot(compressedBase64);
      const result = parseResult(rawText);

      if (!result) return res.json({ ok: false, error: 'Analysis failed' });
      if (result.notAChart) return res.json({ ok: false, notAChart: true, error: 'এটি একটি চার্ট নয়। Quotex chart screenshot দিন।' });
      if (result.noTrade) return res.json({ ok: true, noTrade: true });

      // MongoDB stats
      const db = getDb ? getDb() : null;
      if (db) {
        db.collection('userStats')
          .updateOne({ userId }, {
            $inc: { totalScreenshots: 1, miniappScans: 1 },
            $set: { lastActive: new Date() }
          }, { upsert: true })
          .catch(e => console.log('stats error:', e.message));
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
        const userStats = await db.collection('userStats').findOne({ userId });
        if (userStats) {
          stats.totalSignals = userStats.totalSignals || 0;
          stats.totalScreenshots = userStats.totalScreenshots || 0;
          stats.miniappScans = userStats.miniappScans || 0;
          if (userStats.lastActive) {
            const bd = new Date(new Date(userStats.lastActive).getTime() + 6 * 60 * 60 * 1000);
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
