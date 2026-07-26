// screenshot.js - Weighted Deep Analysis Engine (Screenshot-Only, No External Data)
const https = require('https');
const geminiKeyPool = require('./geminikey');

const ADMIN_ID = 5724602667;

const userScreenshotCount = new Map();

const progressSteps = [
  '🔍 𝗦𝗰𝗮𝗻𝗻𝗶𝗻𝗴 𝗠𝗮𝗿𝗸𝗲𝘁...',
  '📈 𝗖𝗵𝗲𝗰𝗸𝗶𝗻𝗴 𝗠𝗮𝗿𝗸𝗲𝘁 𝗧𝗿𝗲𝗻𝗱...',
  '📊 𝗔𝗻𝗮𝗹𝘆𝘇𝗶𝗻𝗴 𝗣𝗿𝗶𝗰𝗲 𝗔𝗰𝘁𝗶𝗼𝗻...',
  '🎯 𝗘𝗻𝘁𝗿𝘆 𝗖𝗼𝗻𝗳𝗶𝗿𝗺𝗮𝘁𝗶𝗼𝗻...'
];

const GEMINI_MODELS = [
  'gemini-flash-latest',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b'
];

const MAX_ANALYSIS_WAIT_MS = 90 * 1000;
const MIN_SCORE_GAP = 20;

// ✅ নতুন — Entry-র ঠিক কত সেকেন্ড আগে সিগনাল ডেলিভার হবে (ফিক্সড, সবসময় same)
const ENTRY_LEAD_SECONDS = 10;
// ✅ Analysis শেষ হওয়ার পর delivery পর্যন্ত ন্যূনতম কত সেকেন্ড gap থাকা লাগবে —
// এর কম হলে ওই মিনিটের উইন্ডো "মিস" ধরে পরের মিনিটে push হবে
const MIN_LEAD_BUFFER_MS = 2000;

function getBDDateKey() {
  const now = new Date();
  const bd = new Date(now.getTime() + 6 * 60 * 60 * 1000);
  return bd.toISOString().split('T')[0];
}

function getUserCount(userId) {
  const key = userId + '_' + getBDDateKey();
  return userScreenshotCount.get(key) || 0;
}

function incrementUserCount(userId) {
  const key = userId + '_' + getBDDateKey();
  const current = userScreenshotCount.get(key) || 0;
  userScreenshotCount.set(key, current + 1);
}

function getBDTime() {
  const now = new Date();
  const bd = new Date(now.getTime() + 6 * 60 * 60 * 1000);
  const h = String(bd.getUTCHours()).padStart(2, '0');
  const m = String(bd.getUTCMinutes()).padStart(2, '0');
  const s = String(bd.getUTCSeconds()).padStart(2, '0');
  return { h, m, s };
}

function fmtBD(epochMs) {
  const bd = new Date(epochMs + 6 * 60 * 60 * 1000);
  return String(bd.getUTCHours()).padStart(2, '0') + ':' + String(bd.getUTCMinutes()).padStart(2, '0');
}

// ─────────────────────────────────────────────
// ✅ নতুন — Fixed "Entry-র ১০ সেকেন্ড আগে" Delivery Scheduler
// Analysis যখনই শেষ হোক (fromTime), পরবর্তী মিনিট-বাউন্ডারিকে entry ধরে
// সেই entry-র ঠিক ENTRY_LEAD_SECONDS আগের মুহূর্তটাকে delivery time বানায়।
// যদি সেই delivery time ইতিমধ্যে চলে গেছে/খুব কাছাকাছি হয়ে যায় (analysis দেরি হলে),
// তাহলে সেই মিনিট স্কিপ করে পরের মিনিট ধরা হয় — কখনোই কম বাফারে সিগনাল যায় না।
// ─────────────────────────────────────────────
function computeDeliverySchedule(fromTime) {
  let entryMs = Math.ceil(fromTime / 60000) * 60000; // পরের মিনিট-বাউন্ডারি
  let deliveryMs = entryMs - ENTRY_LEAD_SECONDS * 1000;

  while (deliveryMs - fromTime < MIN_LEAD_BUFFER_MS) {
    entryMs += 60000;
    deliveryMs = entryMs - ENTRY_LEAD_SECONDS * 1000;
  }

  const expiryMs = entryMs + 60000;
  return { entryMs, expiryMs, deliveryMs };
}

function buildProgressBlock(activeIndex) {
  const visibleSteps = progressSteps.slice(0, activeIndex + 1);
  return visibleSteps.map((label, idx) => {
    const icon = idx < activeIndex ? '✅' : '🔄';
    return icon + ' ' + label;
  }).join('\n');
}

// Phase A — Gemini এখনো analysis করছে (সময় অনিশ্চিত, তাই countdown না, elapsed দেখানো হচ্ছে)
function buildAnalyzingMessage(elapsedSeconds, activeIndex) {
  const { h, m, s } = getBDTime();
  return (
    '╭━━━━━━━━━━━━━━━━━━━━━━╮\n' +
    '┃ 🧠 𝗔𝗜 𝗗𝗘𝗘𝗣 𝗠𝗔𝗥𝗞𝗘𝗧 𝗔𝗡𝗔𝗟𝗬𝗦𝗜𝗦 ┃\n' +
    '╰━━━━━━━━━━━━━━━━━━━━━━╯\n\n' +
    '⏰ 𝗕𝗗 𝗧𝗶𝗺𝗲 ➜ ' + h + ':' + m + ':' + s + '\n' +
    '⏳ 𝗔𝗻𝗮𝗹𝘆𝘇𝗶𝗻𝗴... (' + elapsedSeconds + 's)\n\n' +
    buildProgressBlock(activeIndex)
  );
}

// Phase B — Analysis শেষ, এখন ঠিক entry-10s এর জন্য অপেক্ষা করা হচ্ছে (real countdown)
function buildWaitingMessage(remainingSeconds, entryDisplay, expiryDisplay) {
  const { h, m, s } = getBDTime();
  return (
    '╭━━━━━━━━━━━━━━━━━━━━━━╮\n' +
    '┃ 🎯 𝗟𝗢𝗖𝗞𝗜𝗡𝗚 𝗘𝗡𝗧𝗥𝗬 𝗪𝗜𝗡𝗗𝗢𝗪 ┃\n' +
    '╰━━━━━━━━━━━━━━━━━━━━━━╯\n\n' +
    '⏰ 𝗕𝗗 𝗧𝗶𝗺𝗲 ➜ ' + h + ':' + m + ':' + s + '\n' +
    '🕒 𝗘𝗻𝘁𝗿𝘆  ➜ ' + entryDisplay + '\n' +
    '⏳ 𝗘𝘅𝗽𝗶𝗿𝘆 ➜ ' + expiryDisplay + '\n\n' +
    '✅ 𝗔𝗻𝗮𝗹𝘆𝘀𝗶𝘀 𝗖𝗼𝗺𝗽𝗹𝗲𝘁𝗲\n' +
    '⏱️ 𝗦𝗶𝗴𝗻𝗮𝗹 𝗶𝗻 ' + remainingSeconds + 's'
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ✅ Weighted Deep Analysis Prompt — অপরিবর্তিত
const ANALYSIS_PROMPT = `STEP 1 - CHART VERIFICATION:
First look at this image carefully. Is this a trading candlestick/price chart (forex or binary options chart with candles, price levels, time axis)?

If this is NOT a trading chart (example: photo, chat screenshot, text image, person, animal, food, or any non-chart image):
Reply with exactly: NOT_A_CHART

If this IS a trading candlestick chart, proceed to STEP 2.

STEP 2 - VISIBLE-ONLY ANALYSIS RULE:
Analyze ONLY what is visibly present on the chart. Never infer, assume, or imagine hidden indicators or missing market data. In particular, NEVER assume the presence of ATR, ADX, VWAP, MFI, OBV, Volume Profile, Ichimoku, Supertrend, or any other indicator unless it is clearly and visibly plotted on the chart. If an indicator is not visible, simply exclude it from the analysis entirely — do not guess its value.

STEP 3 - WEIGHTED CATEGORY ANALYSIS:
Analyze each category below using only visible chart information, and internally weigh them as follows when forming your final score:

MARKET STRUCTURE (weight 30%):
Higher High, Higher Low, Lower High, Lower Low, overall trend, trend strength, swing structure, continuation vs reversal signs.

SMART MONEY CONCEPTS (weight 25%):
Break Of Structure (BOS), Change Of Character (CHOCH), liquidity sweep, stop hunt, order block, breaker block, mitigation block, Fair Value Gap (FVG), premium zone, discount zone.

SUPPORT & RESISTANCE (weight 15%):
Strong support, strong resistance, dynamic support/resistance, previous swing levels, rejection zones.

CANDLESTICK QUALITY (weight 15%):
Engulfing, pin bar, hammer, shooting star, doji, morning star, evening star, three white soldiers, three black crows, harami, tweezer, marubozu. A pattern only counts if it forms at a MEANINGFUL LOCATION — strong support, strong resistance, an order block, a liquidity sweep point, a retest zone, a breakout zone, or a rejection zone. Ignore any pattern that forms in the middle of nowhere with no meaningful location.

MOMENTUM (weight 10%):
Assess momentum strength using only visible price action (candle body sizes, speed of movement, any visible momentum indicator). If the market is flat or momentum is weak, this must pull the score toward NO_TRADE or reduce confidence — never treat weak momentum as tradeable.

ENTRY QUALITY (weight 5%):
Risk vs reward, entry position quality relative to the ideal zone, late entry detection, early entry detection, multi-confirmation. If price has already moved far away from the ideal entry zone (late entry), this must reduce the score — do not generate a fresh signal on a late entry.

STEP 4 - MANDATORY FILTERS (apply after the weighted score above):
- FAKE BREAKOUT FILTER: Reject or heavily penalize any breakout that shows a small-body breakout candle, a long opposite wick, a quick return back inside the range after the breakout, or a weak closing candle. These are signs of a fake breakout and must not produce a signal in that breakout's direction.
- RANGE MARKET FILTER: If the market is sideways/ranging with no clear breakout or clear rejection at range boundaries, this must push toward NO_TRADE — ranging markets produce most false signals.
- LAST THREE CANDLE CONFIRMATION: The last three visible candles must support the final direction. If the last three candles clearly point the opposite way, reduce confidence significantly or return NO_TRADE.

STEP 5 - BULLISH VS BEARISH SCORING:
Using the weighted categories and filters above, compute two scores from 0-100:
BULLISH_SCORE: overall strength of bullish evidence
BEARISH_SCORE: overall strength of bearish evidence
These two scores do not need to sum to 100 — score each side independently based on the evidence for that side.

DECISION LOGIC:
- If BULLISH_SCORE is clearly higher than BEARISH_SCORE (gap of at least ${MIN_SCORE_GAP} points) and above a reasonable quality bar → DIRECTION: BUY
- If BEARISH_SCORE is clearly higher than BULLISH_SCORE (gap of at least ${MIN_SCORE_GAP} points) and above a reasonable quality bar → DIRECTION: SELL
- If the scores are close together, both weak, or any mandatory filter above rejects the setup → DIRECTION: NO_TRADE

Balance requirement: do not be so strict that almost every screenshot returns NO_TRADE, and do not be so lenient that weak/mediocre/range-bound/fake-breakout setups get a signal. Aim for consistent, high-probability signal selection.

STEP 6 - REALISTIC PROBABILITY:
Never inflate win probability. Base it strictly on the visible evidence and the score gap. If there is real uncertainty, lower confidence and win probability rather than overstating them.
- Score gap ${MIN_SCORE_GAP}-35 = Confidence: Medium, Win Probability: 65-70%
- Score gap 36-55 = Confidence: High, Win Probability: 75-80%
- Score gap 56+ = Confidence: Very High, Win Probability: 85%

SETUP QUALITY:
Rate the setup as A+ (exceptional, overwhelming one-sided score, all filters clean), A (strong, solid gap, filters clean), or B (acceptable, meets the minimum bar but not exceptional).

Reply ONLY in this exact format, no asterisks, no extra text:
DIRECTION: BUY or SELL or NO_TRADE
BULLISH_SCORE: (0-100)
BEARISH_SCORE: (0-100)
CONFIDENCE: Medium or High or Very High
WIN_PROBABILITY: 65% to 85%
TREND: (trend description in 4 words)
SETUP_QUALITY: A+ or A or B
REASON: (2 sentence detailed explanation referencing the strongest confirmations and any filter that mattered)`;

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
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const status = res.statusCode;

        if (status === 429) {
          console.log(`GEMINI [${model}] key ...${apiKey.slice(-6)} QUOTA EXCEEDED (429)`);
          resolve({ ok: false, quotaExceeded: true, retryable: true, text: null });
          return;
        }
        if (status === 503 || status >= 500) {
          console.log(`GEMINI [${model}] key ...${apiKey.slice(-6)} RETRYABLE STATUS ${status}:`, data.slice(0, 200));
          resolve({ ok: false, quotaExceeded: false, retryable: true, text: null });
          return;
        }

        try {
          const json = JSON.parse(data);
          if (!json.candidates || !json.candidates[0]) {
            console.log(`GEMINI [${model}] NO CANDIDATES:`, data.slice(0, 200));
            resolve({ ok: false, quotaExceeded: false, retryable: true, text: null });
            return;
          }
          const text = json.candidates[0].content.parts[0].text;
          console.log(`GEMINI [${model}] key ...${apiKey.slice(-6)} RAW:\n` + text);
          resolve({ ok: true, quotaExceeded: false, retryable: false, text });
        } catch (e) {
          console.log(`GEMINI [${model}] PARSE ERROR:`, e.message);
          resolve({ ok: false, quotaExceeded: false, retryable: true, text: null });
        }
      });
    });

    req.on('error', (e) => {
      console.log(`GEMINI [${model}] REQUEST ERROR:`, e.message);
      resolve({ ok: false, quotaExceeded: false, retryable: true, text: null });
    });
    req.write(body);
    req.end();
  });
}

async function analyzeChartWithGemini(imageBase64) {
  const maxRounds = 2;
  const delayBetweenRounds = 3000;

  if (geminiKeyPool.totalKeys === 0) {
    throw new Error('No Gemini API keys configured in Railway Variables');
  }

  for (let round = 0; round < maxRounds; round++) {
    const triedKeys = [];
    while (true) {
      const apiKey = geminiKeyPool.getNextActiveKey(triedKeys);
      if (!apiKey) break;
      triedKeys.push(apiKey);

      for (const model of GEMINI_MODELS) {
        const result = await callGeminiModel(model, apiKey, imageBase64);
        if (result.ok) return result.text;
        if (result.quotaExceeded) { geminiKeyPool.markExhausted(apiKey); break; }
      }
    }
    if (round < maxRounds - 1) await sleep(delayBetweenRounds);
  }

  throw new Error('All Gemini keys/models unavailable after retries');
}

function parseGeminiResponse(text) {
  const upperText = text.trim().toUpperCase();
  if (upperText.includes('NOT_A_CHART')) return { notAChart: true };

  const result = {
    direction: null, bullishScore: null, bearishScore: null,
    confidence: 'Medium', winProbability: '70%', trend: 'N/A', setupQuality: 'B',
    reason: 'AI analysis based signal'
  };

  const lines = text.split('\n');
  for (const line of lines) {
    const clean = line.replace(/\*/g, '').replace(/#/g, '').trim();
    const lower = clean.toLowerCase();

    if (lower.startsWith('direction:')) {
      const val = clean.substring(clean.indexOf(':') + 1).trim().toUpperCase();
      if (val.includes('NO_TRADE') || val.includes('NO TRADE')) result.direction = 'NO_TRADE';
      else if (val.includes('BUY')) result.direction = 'BUY';
      else if (val.includes('SELL')) result.direction = 'SELL';
    }
    else if (lower.startsWith('bullish_score:') || lower.startsWith('bullish score:')) {
      const num = parseInt(clean.replace(/[^0-9]/g, ''), 10);
      result.bullishScore = isNaN(num) ? null : num;
    }
    else if (lower.startsWith('bearish_score:') || lower.startsWith('bearish score:')) {
      const num = parseInt(clean.replace(/[^0-9]/g, ''), 10);
      result.bearishScore = isNaN(num) ? null : num;
    }
    else if (lower.startsWith('confidence:')) result.confidence = clean.substring(clean.indexOf(':') + 1).trim();
    else if (lower.startsWith('win_probability:') || lower.startsWith('win probability:')) result.winProbability = clean.substring(clean.indexOf(':') + 1).trim();
    else if (lower.startsWith('trend:')) result.trend = clean.substring(clean.indexOf(':') + 1).trim();
    else if (lower.startsWith('setup_quality:') || lower.startsWith('setup quality:')) result.setupQuality = clean.substring(clean.indexOf(':') + 1).trim();
    else if (lower.startsWith('reason:')) result.reason = clean.substring(clean.indexOf(':') + 1).trim();
  }

  if (!result.direction) return { noTrade: true };

  if (result.direction !== 'NO_TRADE' && result.bullishScore !== null && result.bearishScore !== null) {
    const gap = Math.abs(result.bullishScore - result.bearishScore);
    if (gap < MIN_SCORE_GAP) return { noTrade: true, trend: result.trend, reason: result.reason };
  }

  if (result.direction === 'NO_TRADE') return { noTrade: true, trend: result.trend, reason: result.reason };

  return result;
}

module.exports = function(bot, db, approvedUsers, bannedUsers, isApproved, getTrialScreenshotLeft, incrementTrialScreenshot, sendVerifyPrompt, FREE_TRIAL_SCREENSHOT, signalInlineKeyboard, lastSignalMsgId, isEmergency) {

  bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (bannedUsers.has(userId)) return;

    if (typeof isEmergency === 'function' && isEmergency()) {
      await bot.sendMessage(chatId, '🛑 Bot এখন Emergency Mode এ আছে, একটু পর আবার চেষ্টা করুন।');
      return;
    }

    if (!isApproved(userId)) {
      if (getTrialScreenshotLeft(userId) <= 0) { sendVerifyPrompt(chatId, userId); return; }
    }

    if (isApproved(userId) && userId !== ADMIN_ID) {
      const count = getUserCount(userId);
      if (count >= 5) {
        await bot.sendMessage(chatId,
          '⚠️ 𝗧𝗼𝗱𝗮𝘆\'𝘀 𝗔𝗜 𝗦𝗰𝗿𝗲𝗲𝗻𝘀𝗵𝗼𝘁 𝗟𝗶𝗺𝗶𝘁 𝗥𝗲𝗮𝗰𝗵𝗲𝗱!\n\n➕ 𝗚𝗲𝗻𝗲𝗿𝗮𝘁𝗲 𝗔𝗜 𝗦𝗶𝗴𝗻𝗮𝗹 📊 বাটন ব্যবহার করে নতুন Signal নিন।',
          { parse_mode: 'Markdown' }
        );
        return;
      }
    }

    if (lastSignalMsgId.has(userId)) {
      try { await bot.deleteMessage(chatId, lastSignalMsgId.get(userId)); } catch (e) {}
      lastSignalMsgId.delete(userId);
    }

    let activeStepIndex = 0;
    let elapsedSeconds = 0;

    const loadMsg = await bot.sendMessage(chatId, buildAnalyzingMessage(elapsedSeconds, activeStepIndex), { parse_mode: 'Markdown' });

    // ✅ Phase A — Gemini analysis চলাকালীন প্রতি সেকেন্ডে ticking (৪ সেকেন্ড পর পর পরের step)
    const tickInterval = setInterval(async () => {
      elapsedSeconds++;
      const targetIndex = Math.min(progressSteps.length - 1, Math.floor(elapsedSeconds / 4));
      if (targetIndex > activeStepIndex) activeStepIndex = targetIndex;
      try {
        await bot.editMessageText(buildAnalyzingMessage(elapsedSeconds, activeStepIndex), { chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'Markdown' });
      } catch (e) {}
    }, 1000);

    try {
      const photos = msg.photo;
      const photo = photos[photos.length - 1];
      const file = await bot.getFile(photo.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;

      const imageData = await new Promise((resolve, reject) => {
        https.get(fileUrl, (res) => {
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        });
      });

      const imageBase64 = imageData.toString('base64');

      const geminiPromise = analyzeChartWithGemini(imageBase64);
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('ANALYSIS_TIMEOUT')), MAX_ANALYSIS_WAIT_MS));

      const geminiResponse = await Promise.race([geminiPromise, timeoutPromise]);
      clearInterval(tickInterval); // Phase A শেষ

      const signal = parseGeminiResponse(geminiResponse);

      if (signal.notAChart) {
        try { await bot.deleteMessage(chatId, loadMsg.message_id); } catch (e) {}
        await bot.sendMessage(chatId,
          '⚠️ 𝗜𝗻𝘃𝗮𝗹𝗶𝗱 𝗖𝗵𝗮𝗿𝘁!\n\n📸 𝗣𝗹𝗲𝗮𝘀𝗲 𝘂𝗽𝗹𝗼𝗮𝗱 𝗮 𝗰𝗹𝗲𝗮𝗿 𝗤𝘂𝗼𝘁𝗲𝘅 𝗖𝗵𝗮𝗿𝘁 𝗦𝗰𝗿𝗲𝗲𝗻𝘀𝗵𝗼𝘁',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      if (signal.noTrade) {
        try { await bot.deleteMessage(chatId, loadMsg.message_id); } catch (e) {}
        await bot.sendMessage(chatId,
          '⚠️ 𝗡𝗢 𝗧𝗥𝗔𝗗𝗘\n\nএই চার্টে যথেষ্ট শক্তিশালী/স্পষ্ট Setup পাওয়া যায়নি।\n\n📸 চাইলে আরেকটা স্পষ্ট (zoomed-in) চার্ট স্ক্রিনশট পাঠান, অথবা 📊 𝗚𝗲𝗻𝗲𝗿𝗮𝘁𝗲 𝗔𝗜 𝗦𝗶𝗴𝗻𝗮𝗹 ব্যবহার করুন।',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // ─────────────────────────────────────────
      // ✅ Phase B — Analysis সফল, এখন ঠিক entry-10s এর জন্য অপেক্ষা
      // ─────────────────────────────────────────
      const schedule = computeDeliverySchedule(Date.now());
      const entryDisplay = fmtBD(schedule.entryMs);
      const expiryDisplay = fmtBD(schedule.expiryMs);

      let waitTicker = null;
      const waitMs = schedule.deliveryMs - Date.now();
      if (waitMs > 0) {
        await new Promise((resolve) => {
          waitTicker = setInterval(async () => {
            const remaining = Math.ceil((schedule.deliveryMs - Date.now()) / 1000);
            if (remaining <= 0) {
              clearInterval(waitTicker);
              resolve();
              return;
            }
            try {
              await bot.editMessageText(buildWaitingMessage(remaining, entryDisplay, expiryDisplay), { chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'Markdown' });
            } catch (e) {}
          }, 1000);
          setTimeout(() => { clearInterval(waitTicker); resolve(); }, waitMs + 200);
        });
      }

      // ✅ trial/count বাড়ানো (delivery নিশ্চিত হওয়ার পর)
      if (isApproved(userId)) {
        incrementUserCount(userId);
      } else {
        await incrementTrialScreenshot(userId);
        const left = getTrialScreenshotLeft(userId);
        if (left === 0) {
          await bot.sendMessage(chatId,
            '⚠️ 𝗟𝗮𝘀𝘁 𝗙𝗿𝗲𝗲 𝗧𝗿𝗶𝗮𝗹 𝗦𝗰𝗿𝗲𝗲𝗻𝘀𝗵𝗼𝘁!\n\n🔓 𝗩𝗲𝗿𝗶𝗳𝘆 𝘆𝗼𝘂𝗿 𝗮𝗰𝗰𝗼𝘂𝗻𝘁 𝘁𝗼 𝘂𝗻𝗹𝗼𝗰𝗸 𝗨𝗻𝗹𝗶𝗺𝗶𝘁𝗲𝗱 𝗔𝗰𝗰𝗲𝘀𝘀.',
            { parse_mode: 'Markdown' }
          );
        }
      }

      const remainingCount = userId === ADMIN_ID
        ? '∞'
        : isApproved(userId) ? String(5 - getUserCount(userId)) : String(getTrialScreenshotLeft(userId));

      const dirLabel = signal.direction === 'BUY' ? '🟢 BUY' : '🔴 SELL';
      const dirEmoji = signal.direction === 'BUY' ? '⏫' : '⏬';
      let confEmoji = '🟡';
      const confLower = (signal.confidence || '').toLowerCase();
      if (confLower.includes('very')) confEmoji = '🔥';
      else if (confLower.includes('high')) confEmoji = '🟢';

      const scoreLine = (signal.bullishScore !== null && signal.bearishScore !== null)
        ? '📉 𝗦𝗖𝗢𝗥𝗘 ➜ Bullish ' + signal.bullishScore + ' | Bearish ' + signal.bearishScore + '\n'
        : '';

      try { await bot.deleteMessage(chatId, loadMsg.message_id); } catch (e) {}

      const sentMsg = await bot.sendMessage(chatId,
        '╔════════════════════╗\n' +
        '🧠 𝗔𝗜 𝗖𝗛𝗔𝗥𝗧 𝗔𝗡𝗔𝗟𝗬𝗦𝗜𝗦\n' +
        '╚════════════════════╝\n\n' +
        '📈 𝗗𝗜𝗥𝗘𝗖𝗧𝗜𝗢𝗡 ➜ ' + dirLabel + ' ' + dirEmoji + '\n' +
        '🕒 𝗘𝗡𝗧𝗥𝗬     ➜ ' + entryDisplay + '\n' +
        '⏳ 𝗘𝗫𝗣𝗜𝗥𝗬    ➜ ' + expiryDisplay + '\n\n' +
        '━━━━━━━━━━━━━━━━\n\n' +
        '🎯 𝗖𝗢𝗡𝗙𝗜𝗗𝗘𝗡𝗖𝗘 ➜ ' + signal.confidence + ' ' + confEmoji + ' (' + signal.winProbability + ')\n' +
        scoreLine +
        '📊 𝗧𝗥𝗘𝗡𝗗 ➜ ' + signal.trend + '\n' +
        '🏆 𝗦𝗘𝗧𝗨𝗣 ➜ ' + signal.setupQuality + '\n\n' +
        '💡 𝗔𝗜 𝗩𝗜𝗘𝗪\n' + signal.reason + '\n\n' +
        '━━━━━━━━━━━━━━━━\n\n' +
        '📸 𝗦𝗰𝗿𝗲𝗲𝗻𝘀𝗵𝗼𝘁𝘀 𝗟𝗲𝗳𝘁: *' + remainingCount + '/3*\n\n' +
        '⚠️ 𝗠𝗮𝘅 𝟭 𝗦𝘁𝗲𝗽 𝗠𝗧𝗚',
        { parse_mode: 'Markdown', reply_markup: signalInlineKeyboard }
      );

      lastSignalMsgId.set(userId, sentMsg.message_id);

    } catch (e) {
      clearInterval(tickInterval);
      console.log('ERROR:', e.message);
      try { await bot.deleteMessage(chatId, loadMsg.message_id); } catch (err) {}

      if (e.message === 'ANALYSIS_TIMEOUT') {
        await bot.sendMessage(chatId,
          '⏱️ 𝗔𝗻𝗮𝗹𝘆𝘀𝗶𝘀 𝗧𝗼𝗼𝗸 𝗧𝗼𝗼 𝗟𝗼𝗻𝗴\n\nAI সার্ভার এই মুহূর্তে ধীর সাড়া দিচ্ছে। অনুগ্রহ করে আবার চেষ্টা করুন।\n\n➕ Tap 𝗚𝗲𝗻𝗲𝗿𝗮𝘁𝗲 𝗔𝗜 𝗦𝗶𝗴𝗻𝗮𝗹 📊',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      await bot.sendMessage(chatId,
        '⚠️ 𝗢𝗼𝗽𝘀! 𝗦𝗼𝗿𝗿𝘆 𝘀𝗼𝗺𝗲𝘁𝗵𝗶𝗻𝗴 𝘄𝗲𝗻𝘁 𝘄𝗿𝗼𝗻𝗴 𝘄𝗵𝗶𝗹𝗲 𝗮𝗻𝗮𝗹𝘆𝘇𝗶𝗻𝗴 𝘁𝗵𝗲 𝗰𝗵𝗮𝗿𝘁.\n\n🔄 𝗣𝗹𝗲𝗮𝘀𝗲 𝘁𝗿𝘆 𝗮𝗴𝗮𝗶𝗻 𝗶𝗻 𝗮 𝗳𝗲𝘄 𝘀𝗲𝗰𝗼𝗻𝗱𝘀.\n\n➕ Tap 𝗚𝗲𝗻𝗲𝗿𝗮𝘁𝗲 𝗔𝗜 𝗦𝗶𝗴𝗻𝗮𝗹 📊',
        { parse_mode: 'Markdown' }
      );
    }
  });
};
