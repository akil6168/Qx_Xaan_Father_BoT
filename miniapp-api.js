const crypto = require('crypto');

const ADMIN_ID = 5724602667;
const REGISTRATION_CHANNEL_ID = '-1002368787439';

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

const { addScanRoute } = require('./miniapp-scan-route');

// ====== Screenshot Analysis (same logic as screenshot.js) ======
const geminiKeyPool = require('./geminikey');

const GEMINI_MODELS = [
  'gemini-flash-latest',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b'
];

const MIN_SCORE_GAP = 20;

const ANALYSIS_PROMPT = `STEP 1 - CHART VERIFICATION:
First look at this image carefully. Is this a trading candlestick/price chart (forex or binary options chart with candles, price levels, time axis)?

If this is NOT a trading chart (example: photo, chat screenshot, text image, person, animal, food, or any non-chart image):
Reply with exactly: NOT_A_CHART

If this IS a trading candlestick chart, proceed to STEP 2.

STEP 2 - VISIBLE-ONLY ANALYSIS RULE:
Analyze ONLY what is visibly present on the chart. Never infer, assume, or imagine hidden indicators.

STEP 3 - MULTI-CONFIRMATION IDENTIFICATION:
Find every independent confirmation: Market Structure, Smart Money Concepts, Support & Resistance, Candlestick Quality, Momentum, Entry Quality.

STEP 4 - WEIGHTED CATEGORY SCORING:
Score using visible chart information with these weights:
MARKET STRUCTURE (30%), SMART MONEY CONCEPTS (25%), SUPPORT & RESISTANCE (15%), CANDLESTICK QUALITY (15%), MOMENTUM (10%), ENTRY QUALITY (5%).

STEP 5 - CONFIDENCE ADJUSTMENT:
Check for fake breakouts, choppy markets, and last 3 candle direction.

STEP 6 - SCORING:
Compute BULLISH_SCORE and BEARISH_SCORE (0-100 each, independently).
DECISION: gap >= ${MIN_SCORE_GAP} → BUY or SELL. gap < ${MIN_SCORE_GAP} → NO_TRADE.

STEP 7 - WIN PROBABILITY:
Gap ${MIN_SCORE_GAP}-35 = Medium, 65-70%. Gap 36-55 = High, 75-80%. Gap 56+ = Very High, 85%.

Reply ONLY in this exact format:
DIRECTION: BUY or SELL or NO_TRADE
BULLISH_SCORE: (0-100)
BEARISH_SCORE: (0-100)
CONFIDENCE: Medium or High or Very High
WIN_PROBABILITY: 65% to 85%
TREND: (4 words)
SETUP_QUALITY: A+ or A or B
REASON: (checkmarked confirmations)`;

function callGeminiForScreenshot(model, apiKey, imageBase64) {
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
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };

    const https = require('https');
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          resolve({ ok: true, text });
        } catch (e) {
          resolve({ ok: false, error: e.message });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(30000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

async function analyzeScreenshot(imageBase64) {
  const keys = geminiKeyPool.getKeys ? geminiKeyPool.getKeys() : (geminiKeyPool.keys || []);
  if (!keys || keys.length === 0) throw new Error('No Gemini keys available');

  for (const model of GEMINI_MODELS) {
    for (const key of keys) {
      const result = await callGeminiForScreenshot(model, key, imageBase64);
      if (result.ok && result.text && result.text.length > 10) {
        return result.text;
      }
    }
  }
  throw new Error('All Gemini models failed');
}

function parseScreenshotResult(text) {
  if (!text) return null;
  if (text.trim() === 'NOT_A_CHART') return { notAChart: true };

  const get = (key) => {
    const match = text.match(new RegExp(`${key}:\\s*(.+)`));
    return match ? match[1].trim() : null;
  };

  const direction = get('DIRECTION');
  if (!direction) return null;
  if (direction === 'NO_TRADE') return { noTrade: true };

  const bullish = parseInt(get('BULLISH_SCORE') || '0');
  const bearish = parseInt(get('BEARISH_SCORE') || '0');

  return {
    direction: direction === 'BUY' ? 'CALL' : 'PUT',
    confidence: parseInt(get('WIN_PROBABILITY') || '70'),
    trend: get('TREND') || 'Unknown',
    pattern: get('SETUP_QUALITY') || 'B',
    analysis: get('REASON') || '',
    bullishScore: bullish,
    bearishScore: bearish,
    confidenceLabel: get('CONFIDENCE') || 'Medium',
    bullish_indicators: direction === 'BUY' ? ['Strong Structure', 'Bullish Momentum'] : [],
    bearish_indicators: direction === 'SELL' ? ['Strong Structure', 'Bearish Momentum'] : [],
  };
}

// ====== News Prediction Logic ======
function generateNewsPrediction(event) {
  const forecast = parseFloat(event.forecast);
  const previous = parseFloat(event.previous);

  if (isNaN(forecast) || isNaN(previous)) {
    return {
      direction: 'NEUTRAL',
      reason: 'Forecast বা Previous data নেই — news release এর পর chart দেখুন।',
      pairs: []
    };
  }

  const currency = event.currency || 'USD';
  const isPositive = forecast > previous;
  const diff = Math.abs(forecast - previous);
  const pctDiff = previous !== 0 ? (diff / Math.abs(previous)) * 100 : 0;

  // Pairs based on currency
  const currencyPairs = {
    USD: ['EUR/USD', 'GBP/USD', 'USD/JPY'],
    EUR: ['EUR/USD', 'EUR/GBP', 'EUR/JPY'],
    GBP: ['GBP/USD', 'EUR/GBP', 'GBP/JPY'],
    JPY: ['USD/JPY', 'EUR/JPY', 'GBP/JPY'],
    AUD: ['AUD/USD', 'AUD/JPY'],
    CAD: ['USD/CAD', 'CAD/JPY'],
    CHF: ['USD/CHF', 'EUR/CHF'],
    NZD: ['NZD/USD', 'NZD/JPY'],
  };

  const pairs = currencyPairs[currency] || [];

  // Direction: positive news = currency UP
  // For USD: positive = USD up = EUR/USD down, USD/JPY up
  const direction = isPositive ? 'UP' : 'DOWN';
  const strength = pctDiff > 10 ? 'Strong' : pctDiff > 3 ? 'Moderate' : 'Weak';

  const reason = `${currency} news: Forecast ${event.forecast} vs Previous ${event.previous} — ${strength} ${isPositive ? 'positive' : 'negative'} surprise। ${currency} pair এ ${isPositive ? 'bullish' : 'bearish'} move সম্ভব।`;

  return { direction, reason, pairs };
}

function registerMiniAppRoutes(app, { getDb, approvedUsers, bannedUsers, submissions, isApproved, getMiniappTrialLeft, incrementMiniappTrial, MINIAPP_FREE_TRIAL, bot, getCachedNews }) {
  app.use(require('express').json({ limit: '20mb' }));

  app.use('/miniapp', (req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type, X-Requested-With');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

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
      console.error('miniapp /verify error:', e.message);
      return res.status(500).json({ verified: false, error: 'server error' });
    }
  });

  // ====== /miniapp/screenshot-analyze (নতুন) ======
  app.post('/miniapp/screenshot-analyze', async (req, res) => {
    try {
      const { initData, imageBase64, mimeType } = req.body;
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
        if (trialLeft <= 0) {
          return res.json({ ok: false, reason: 'TRIAL_EXHAUSTED' });
        }
        if (incrementMiniappTrial) incrementMiniappTrial(userId);
      }

      // Analyze
      const rawText = await analyzeScreenshot(imageBase64);
      const result = parseScreenshotResult(rawText);

      if (!result) return res.json({ ok: false, error: 'Analysis failed' });
      if (result.notAChart) return res.json({ ok: false, error: 'NOT_A_CHART', notAChart: true });
      if (result.noTrade) return res.json({ ok: true, noTrade: true });

      // MongoDB stats update
      const db = getDb ? getDb() : null;
      if (db) {
        db.collection('userStats')
          .updateOne({ userId }, { $inc: { totalScreenshots: 1, miniappScans: 1 }, $set: { lastActive: new Date() } }, { upsert: true })
          .catch(e => console.log('userStats update error:', e.message));
      }

      // Notify registration channel
      if (bot && !approved) {
        bot.sendMessage(REGISTRATION_CHANNEL_ID,
          `📸 Mini App Screenshot Analyzed\n👤 User: ${tgUser.first_name} (${userId})\n📊 Result: ${result.direction}\n🎯 Confidence: ${result.confidence}%`
        ).catch(() => {});
      }

      return res.json({ ok: true, result });
    } catch (e) {
      console.error('miniapp /screenshot-analyze error:', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ====== /miniapp/news (নতুন) ======
  app.get('/miniapp/news', async (req, res) => {
    try {
      // getCachedNews is from news.js
      const rawNews = getCachedNews ? getCachedNews() : [];

      const highImpact = rawNews
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

      return res.json({ ok: true, events: highImpact });
    } catch (e) {
      console.error('miniapp /news error:', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ====== /miniapp/profile (নতুন) ======
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
      console.error('miniapp /profile error:', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  });
}

module.exports = { registerMiniAppRoutes, validateInitData };
