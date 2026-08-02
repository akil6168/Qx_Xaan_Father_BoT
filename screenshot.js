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

// ✅ Analysis-এর জন্য সর্বোচ্চ কতক্ষণ অপেক্ষা করা হবে (এর বেশি হলে honest fail মেসেজ দেখানো হবে)
const MAX_ANALYSIS_WAIT_MS = 90 * 1000;

// ✅ Bullish/Bearish Score-এর ব্যবধান কতটুকু হলে সিদ্ধান্তকে "clear" ধরা হবে (কাছাকাছি স্কোর হলে NO_TRADE)
const MIN_SCORE_GAP = 20;

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

function getSecondsUntilNext50() {
  const now = new Date();
  const bd = new Date(now.getTime() + 6 * 60 * 60 * 1000);
  const s = bd.getUTCSeconds();
  return s < 50 ? 50 - s : (60 - s) + 50;
}

// ✅ সবসময় "এই মুহূর্ত থেকে" হিসাব করে, তাই যেকোনো সময় কল করলেই সঠিক ভবিষ্যত entry পাওয়া যায়
function getEntryExpiry() {
  const now = new Date();
  const bd = new Date(now.getTime() + 6 * 60 * 60 * 1000);
  const s = bd.getUTCSeconds();
  const h = bd.getUTCHours();
  const m = bd.getUTCMinutes();

  const entryMinute = s < 50 ? m + 1 : m + 2;
  const expiryMinute = entryMinute + 1;

  const entryH = String(h + Math.floor(entryMinute / 60)).padStart(2, '0');
  const entryM = String(entryMinute % 60).padStart(2, '0');
  const expiryH = String(h + Math.floor(expiryMinute / 60)).padStart(2, '0');
  const expiryM = String(expiryMinute % 60).padStart(2, '0');

  return {
    entry: entryH + ':' + entryM,
    expiry: expiryH + ':' + expiryM
  };
}

function buildProgressBlock(activeIndex) {
  const visibleSteps = progressSteps.slice(0, activeIndex + 1);
  return visibleSteps.map((label, idx) => {
    const icon = idx < activeIndex ? '✅' : '🔄';
    return icon + ' ' + label;
  }).join('\n');
}

function buildAnalysisMessage(remaining, activeIndex) {
  const { h, m, s } = getBDTime();
  return (
    '╭━━━━━━━━━━━━━━━━━━━━━━╮\n' +
    '┃ 🧠 𝗔𝗜 𝗗𝗘𝗘𝗣 𝗠𝗔𝗥𝗞𝗘𝗧 𝗔𝗡𝗔𝗟𝗬𝗦𝗜𝗦 ┃\n' +
    '╰━━━━━━━━━━━━━━━━━━━━━━╯\n\n' +
    '⏰ 𝗕𝗗 𝗧𝗶𝗺𝗲 ➜ ' + h + ':' + m + ':' + s + '\n' +
    '⏳ 𝗔𝗻𝗮𝗹𝘆𝘇𝗶𝗻𝗴... (' + Math.max(0, remaining) + 's+)\n\n' +
    buildProgressBlock(activeIndex)
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ✅ Weighted Deep Analysis Prompt — Bullish/Bearish Score + Multi-Confirmation Confidence Scoring
// (v2: former "mandatory filters" that pushed toward NO_TRADE have been converted into
// confidence-only adjustment factors, so Signal Frequency stays the same while Accuracy/Confidence
// grading gets deeper. Only the BULLISH_SCORE vs BEARISH_SCORE gap decides BUY/SELL/NO_TRADE.)
const ANALYSIS_PROMPT = `STEP 1 - CHART VERIFICATION:
First look at this image carefully. Is this a trading candlestick/price chart (forex or binary options chart with candles, price levels, time axis)?

If this is NOT a trading chart (example: photo, chat screenshot, text image, person, animal, food, or any non-chart image):
Reply with exactly: NOT_A_CHART

If this IS a trading candlestick chart, proceed to STEP 2.

STEP 2 - VISIBLE-ONLY ANALYSIS RULE:
Analyze ONLY what is visibly present on the chart. Never infer, assume, or imagine hidden indicators or missing market data. In particular, NEVER assume the presence of ATR, ADX, VWAP, MFI, OBV, Volume Profile, Ichimoku, Supertrend, or any other indicator unless it is clearly and visibly plotted on the chart. If an indicator is not visible, simply exclude it from the analysis entirely — do not guess its value.

STEP 3 - MULTI-CONFIRMATION IDENTIFICATION:
Before scoring, list out every independent confirmation you can find on the chart, drawn from these categories: Market Structure (HH/HL/LH/LL, trend continuation, trend exhaustion, swing strength, BOS, CHOCH), Smart Money Concepts (liquidity sweep, stop hunt, order block, breaker block, mitigation block, Fair Value Gap, premium/discount zone), Support & Resistance (strong support/resistance, previous high/low, supply/demand zone, clean reaction), Candlestick Quality (pattern type + strength: engulfing strength, pin bar quality, hammer, shooting star, doji, consecutive doji, strong body vs weak body, long upper/lower wick), Momentum (candle body size, consecutive bullish/bearish candles, price acceleration), and Entry Quality (risk/reward, entry position relative to the ideal zone). Aim to find at least 3 independent confirmations supporting the stronger side — the MORE independent, aligned confirmations you find, the HIGHER the score/confidence should be for that side. Fewer confirmations should simply score lower — they do not disqualify a direction on their own.

STEP 4 - WEIGHTED CATEGORY SCORING:
Score each category below using only visible chart information, and internally weigh them as follows when forming BULLISH_SCORE and BEARISH_SCORE:

MARKET STRUCTURE (weight 30%): Higher High, Higher Low, Lower High, Lower Low, overall trend, trend strength, trend continuation vs exhaustion, swing structure, BOS, CHOCH.

SMART MONEY CONCEPTS (weight 25%): Break Of Structure (BOS), Change Of Character (CHOCH), liquidity sweep, stop hunt, order block, breaker block, mitigation block, Fair Value Gap (FVG), premium zone, discount zone. When multiple SMC elements align on the same side, this should meaningfully raise that side's score.

SUPPORT & RESISTANCE (weight 15%): Strong support, strong resistance, dynamic support/resistance, previous swing high/low, supply/demand zone, rejection zones. A clean, clear reaction from a zone raises the score for that direction.

CANDLESTICK QUALITY (weight 15%): Judge pattern quality, not just pattern presence — engulfing strength, pin bar quality, hammer, shooting star, doji, consecutive doji, morning star, evening star, three white soldiers, three black crows, harami, tweezer, marubozu, strong body vs weak body, long upper/lower wick. A pattern counts most at a MEANINGFUL LOCATION (support/resistance, order block, liquidity sweep point, retest/breakout/rejection zone). A weak-quality or badly-located candle should simply score lower on this category, not be discarded from the analysis.

MOMENTUM (weight 10%): Judge momentum using candle body sizes, consecutive same-direction candles, speed/acceleration of price movement, and any visible momentum indicator. Weak or flat momentum should lower this category's score and pull CONFIDENCE down — it should not by itself force NO_TRADE.

ENTRY QUALITY (weight 5%): Risk vs reward, entry position quality relative to the ideal zone, late-entry / early-entry detection, how many independent confirmations line up (multi-confirmation from STEP 3). A late entry should lower this category's score and be mentioned in REASON — it should not by itself cancel a signal.

STEP 5 - CONFIDENCE ADJUSTMENT FACTORS (apply on top of the weighted score — these shift score/confidence, they never force NO_TRADE by themselves):
- FAKE BREAKOUT CHECK: If a breakout shows a small-body breakout candle, a long opposite wick, a quick return back inside the range, or a weak closing candle, lower the score/confidence on that breakout's direction rather than removing the signal.
- RANGE / CHOPPY MARKET CHECK: If the market is sideways/ranging, lower the score/confidence — but if there is still a clear structural lean, edge break, or clean zone reaction, keep the signal and reflect the uncertainty through CONFIDENCE and SETUP_QUALITY instead of blocking it.
- LAST THREE CANDLE CHECK: If the last three visible candles clearly oppose the leaning direction, lower confidence for that direction — reflect this in the score gap and in REASON rather than forcing NO_TRADE outright.

STEP 6 - BULLISH VS BEARISH SCORING:
Using the confirmations, weighted categories, and adjustment factors above, compute two scores from 0-100:
BULLISH_SCORE: overall strength of bullish evidence
BEARISH_SCORE: overall strength of bearish evidence
These two scores do not need to sum to 100 — score each side independently based on the evidence for that side.

DECISION LOGIC (this is the ONLY thing that decides BUY/SELL/NO_TRADE — confirmation count and adjustment factors above only move the score, they do not gate the decision separately):
- If BULLISH_SCORE is clearly higher than BEARISH_SCORE (gap of at least ${MIN_SCORE_GAP} points) → DIRECTION: BUY
- If BEARISH_SCORE is clearly higher than BULLISH_SCORE (gap of at least ${MIN_SCORE_GAP} points) → DIRECTION: SELL
- Only if the two scores are genuinely close together (gap under ${MIN_SCORE_GAP}) → DIRECTION: NO_TRADE

Frequency requirement: the goal is IMPROVING ACCURACY through richer confirmation and confidence analysis, NOT reducing how often a signal is generated. Do not add any extra strictness beyond the score-gap rule above. A weaker/riskier setup should still get BUY or SELL with a lower CONFIDENCE and SETUP_QUALITY (e.g. Medium / B) rather than being converted to NO_TRADE — reserve NO_TRADE strictly for the case where the score gap itself is under ${MIN_SCORE_GAP}.

STEP 7 - REALISTIC PROBABILITY:
Never inflate win probability. Base it strictly on the visible evidence, the number/quality of aligned confirmations, and the score gap. If there is real uncertainty, lower confidence and win probability rather than overstating them.
- Score gap ${MIN_SCORE_GAP}-35 = Confidence: Medium, Win Probability: 65-70%
- Score gap 36-55 = Confidence: High, Win Probability: 75-80%
- Score gap 56+ = Confidence: Very High, Win Probability: 85%

SETUP QUALITY:
Rate the setup as A+ (exceptional — many aligned independent confirmations, overwhelming one-sided score, no adjustment-factor concerns), A (strong — solid gap, good confirmations, minor or no adjustment-factor concerns), or B (acceptable — meets the score-gap bar but with fewer confirmations or some adjustment-factor concerns like a choppy market or late entry).

Reply ONLY in this exact format, no asterisks, no extra text:
DIRECTION: BUY or SELL or NO_TRADE
BULLISH_SCORE: (0-100)
BEARISH_SCORE: (0-100)
CONFIDENCE: Medium or High or Very High
WIN_PROBABILITY: 65% to 85%
TREND: (trend description in 4 words)
SETUP_QUALITY: A+ or A or B
REASON: (single line — 3 to 5 short checkmarked confirmations that mattered most, e.g. "✓ Strong BOS ✓ Liquidity Sweep ✓ Bullish Order Block ✓ Strong Engulfing", optionally followed by a short note on any adjustment factor that affected confidence)`;

function callGeminiModel(model, apiKey, imageBase64) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      contents: [{
        parts: [
          {
            inline_data: {
              mime_type: 'image/jpeg',
              data: imageBase64
            }
          },
          {
            text: ANALYSIS_PROMPT
          }
        ]
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 1024
      }
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

        if (result.ok) {
          return result.text;
        }

        if (result.quotaExceeded) {
          geminiKeyPool.markExhausted(apiKey);
          break;
        }
      }
    }

    if (round < maxRounds - 1) {
      await sleep(delayBetweenRounds);
    }
  }

  throw new Error('All Gemini keys/models unavailable after retries');
}

// ✅ পার্সিং — DIRECTION/BULLISH_SCORE/BEARISH_SCORE/CONFIDENCE/WIN_PROBABILITY/TREND/SETUP_QUALITY/REASON
function parseGeminiResponse(text) {
  const upperText = text.trim().toUpperCase();

  if (upperText.includes('NOT_A_CHART')) {
    return { notAChart: true };
  }

  const result = {
    direction: null,
    bullishScore: null,
    bearishScore: null,
    confidence: 'Medium',
    winProbability: '70%',
    trend: 'N/A',
    setupQuality: 'B',
    reason: 'AI analysis based signal'
  };

  const lines = text.split('\n');
  for (const line of lines) {
    const clean = line.replace(/\*/g, '').replace(/#/g, '').trim();
    const lower = clean.toLowerCase();

    if (lower.startsWith('direction:')) {
      const val = clean.substring(clean.indexOf(':') + 1).trim().toUpperCase();
      if (val.includes('NO_TRADE') || val.includes('NO TRADE')) {
        result.direction = 'NO_TRADE';
      } else if (val.includes('BUY')) {
        result.direction = 'BUY';
      } else if (val.includes('SELL')) {
        result.direction = 'SELL';
      }
    }
    else if (lower.startsWith('bullish_score:') || lower.startsWith('bullish score:')) {
      const num = parseInt(clean.replace(/[^0-9]/g, ''), 10);
      result.bullishScore = isNaN(num) ? null : num;
    }
    else if (lower.startsWith('bearish_score:') || lower.startsWith('bearish score:')) {
      const num = parseInt(clean.replace(/[^0-9]/g, ''), 10);
      result.bearishScore = isNaN(num) ? null : num;
    }
    else if (lower.startsWith('confidence:')) {
      result.confidence = clean.substring(clean.indexOf(':') + 1).trim();
    }
    else if (lower.startsWith('win_probability:') || lower.startsWith('win probability:')) {
      result.winProbability = clean.substring(clean.indexOf(':') + 1).trim();
    }
    else if (lower.startsWith('trend:')) {
      result.trend = clean.substring(clean.indexOf(':') + 1).trim();
    }
    else if (lower.startsWith('setup_quality:') || lower.startsWith('setup quality:')) {
      result.setupQuality = clean.substring(clean.indexOf(':') + 1).trim();
    }
    else if (lower.startsWith('reason:')) {
      result.reason = clean.substring(clean.indexOf(':') + 1).trim();
    }
  }

  // ✅ direction পার্স করা না গেলে জোর করে BUY/SELL ধরা হবে না — NO_TRADE হিসেবে গণ্য
  if (!result.direction) {
    return { noTrade: true };
  }

  // ✅ সেফটি চেক — model যদি স্কোর কাছাকাছি রেখে ভুলে BUY/SELL দিয়ে দেয়, এখানে আবার NO_TRADE-এ ঠেলে দেওয়া হয়
  if (result.direction !== 'NO_TRADE' && result.bullishScore !== null && result.bearishScore !== null) {
    const gap = Math.abs(result.bullishScore - result.bearishScore);
    if (gap < MIN_SCORE_GAP) {
      return { noTrade: true, trend: result.trend, reason: result.reason };
    }
  }

  if (result.direction === 'NO_TRADE') {
    return { noTrade: true, trend: result.trend, reason: result.reason };
  }

  return result;
}

module.exports = function(bot, db, approvedUsers, bannedUsers, isApproved, getTrialScreenshotLeft, incrementTrialScreenshot, sendVerifyPrompt, FREE_TRIAL_SCREENSHOT, signalInlineKeyboard, lastSignalMsgId, isEmergency, isMaintenance) {

  bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (bannedUsers.has(userId)) return;

    // ✅ ফিক্স — Emergency/Maintenance চালু থাকলে বট সম্পূর্ণ নিশ্চুপ থাকবে, কোনো মেসেজ যাবে না
    if ((typeof isEmergency === 'function' && isEmergency()) ||
        (typeof isMaintenance === 'function' && isMaintenance())) {
      return;
    }

    if (!isApproved(userId)) {
      if (getTrialScreenshotLeft(userId) <= 0) {
        sendVerifyPrompt(chatId, userId);
        return;
      }
    }

    if (isApproved(userId) && userId !== ADMIN_ID) {
      const count = getUserCount(userId);
      if (count >= 5) {
        await bot.sendMessage(chatId,
          '⚠️ 𝗧𝗼𝗱𝗮𝘆\'𝘀 𝗔𝗜 𝗦𝗰𝗿𝗲𝗲𝗻𝘀𝗵𝗼𝘁 𝗟𝗶𝗺𝗶𝘁 𝗥𝗲𝗮𝗰𝗵𝗲𝗱!\n\n' +
          '➕ 𝗚𝗲𝗻𝗲𝗿𝗮𝘁𝗲 𝗔𝗜 𝗦𝗶𝗴𝗻𝗮𝗹 📊 বাটন ব্যবহার করে নতুন Signal নিন।',
          { parse_mode: 'Markdown' }
        );
        return;
      }
    }

    if (lastSignalMsgId.has(userId)) {
      try { await bot.deleteMessage(chatId, lastSignalMsgId.get(userId)); } catch (e) {}
      lastSignalMsgId.delete(userId);
    }

    // ✅ শুধু লোডিং বার দেখানোর জন্য একটা আনুমানিক ওয়েট — চূড়ান্ত entry/expiry পরে fresh হিসাব হবে
    const waitSeconds = getSecondsUntilNext50();

    let activeStepIndex = 0;
    let remaining = waitSeconds;

    const loadMsg = await bot.sendMessage(chatId,
      buildAnalysisMessage(remaining, activeStepIndex),
      { parse_mode: 'Markdown' }
    );

    const stepDuration = Math.max(1, Math.floor(waitSeconds / progressSteps.length));
    let elapsedSeconds = 0;

    // ✅ ফিক্স — remaining এখন প্রতি Tick-এ আসল ঘড়ির সময় থেকে fresh হিসাব হচ্ছে (getSecondsUntilNext50()),
    // waitSeconds - elapsedSeconds এর মতো স্থির/অনুমাননির্ভর হিসাব না। এতে UI Countdown সবসময় বাস্তব
    // Wait-এর সাথে Sync থাকে, Gemini দেরি করলে বা মূল xx:xx:50 পার হয়ে গেলেও (পরের xx:xx:50-এর জন্য) সঠিক দেখাবে।
    const tickInterval = setInterval(async () => {
      elapsedSeconds++;
      remaining = getSecondsUntilNext50();

      const targetIndex = Math.min(
        progressSteps.length - 1,
        Math.floor(elapsedSeconds / stepDuration)
      );
      if (targetIndex > activeStepIndex) {
        activeStepIndex = targetIndex;
      }

      try {
        await bot.editMessageText(
          buildAnalysisMessage(remaining, activeStepIndex),
          { chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'Markdown' }
        );
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

      const rawBase64 = imageData.toString('base64');
// ✅ Smart crop: Top 20% + Bottom 30% কাটো, resize 900px
let imageBase64 = rawBase64;
try {
  const sharp = require('sharp');
  const meta = await sharp(imageData).metadata();
  const { width, height } = meta;
  const topCrop = Math.round(height * 0.20);
  const bottomCrop = Math.round(height * 0.30);
  const cropHeight = height - topCrop - bottomCrop;
  if (cropHeight > 100 && width > 100) {
    const cropped = await sharp(imageData)
      .extract({ left: 0, top: topCrop, width, height: cropHeight })
      .resize({ width: 900, withoutEnlargement: true })
      .jpeg({ quality: 78 })
      .toBuffer();
    imageBase64 = cropped.toString('base64');
    console.log(`✂️ Screenshot cropped: ${Math.round(imageData.length/1024)}KB → ${Math.round(cropped.length/1024)}KB`);
  }
} catch (cropErr) {
  console.log('⚠️ Crop failed, using original:', cropErr.message);
}

      // ✅ সর্বোচ্চ MAX_ANALYSIS_WAIT_MS পর্যন্ত অপেক্ষা, তার বেশি হলে টাইমআউট এরর
      const geminiPromise = analyzeChartWithGemini(imageBase64);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('ANALYSIS_TIMEOUT')), MAX_ANALYSIS_WAIT_MS)
      );

      const geminiResponse = await Promise.race([geminiPromise, timeoutPromise]);

      const signal = parseGeminiResponse(geminiResponse);

      if (signal.notAChart) {
        clearInterval(tickInterval);
        try { await bot.deleteMessage(chatId, loadMsg.message_id); } catch (e) {}
        await bot.sendMessage(chatId,
          '⚠️ 𝗜𝗻𝘃𝗮𝗹𝗶𝗱 𝗖𝗵𝗮𝗿𝘁!\n\n' +
          '📸 𝗣𝗹𝗲𝗮𝘀𝗲 𝘂𝗽𝗹𝗼𝗮𝗱 𝗮 𝗰𝗹𝗲𝗮𝗿 𝗤𝘂𝗼𝘁𝗲𝘅 𝗖𝗵𝗮𝗿𝘁 𝗦𝗰𝗿𝗲𝗲𝗻𝘀𝗵𝗼𝘁',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      if (signal.noTrade) {
        clearInterval(tickInterval);
        try { await bot.deleteMessage(chatId, loadMsg.message_id); } catch (e) {}
        await bot.sendMessage(chatId,
          '⚠️ 𝗡𝗢 𝗧𝗥𝗔𝗗𝗘\n\n' +
          'এই চার্টে যথেষ্ট শক্তিশালী/স্পষ্ট Setup পাওয়া যায়নি।\n\n' +
          '📸 চাইলে আরেকটা স্পষ্ট (zoomed-in) চার্ট স্ক্রিনশট পাঠান, অথবা 📊 𝗚𝗲𝗻𝗲𝗿𝗮𝘁𝗲 𝗔𝗜 𝗦𝗶𝗴𝗻𝗮𝗹 ব্যবহার করুন।',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // ✅ মূল ফিক্স — Gemini Analysis শেষ হওয়ার পর, বর্তমান সময় থেকে পরবর্তী xx:xx:50 পর্যন্ত
      // যত সেকেন্ড বাকি তা fresh করে বের করে ততক্ষণ আসলেই Wait করা হচ্ছে (আগে এই Delay-টাই ছিল না,
      // ফলে Gemini দ্রুত শেষ হলে Signal সময়ের আগেই চলে যেত)। UI Tick Interval এই পুরো সময় ধরে চলতেই থাকে,
      // তাই Countdown এবং বাস্তব Wait সবসময় Sync থাকে।
      const finalWaitSeconds = getSecondsUntilNext50();
      await sleep(finalWaitSeconds * 1000);

      clearInterval(tickInterval);

      // ✅ Wait শেষ হওয়ার পরই entry/expiry calculate করা হচ্ছে (Late/Early Entry এড়াতে)
      const { entry, expiry } = getEntryExpiry();

      // ✅ নতুন — lifetime screenshot count MongoDB-তে persist (User Profile-এ "📸 Screenshot" দেখানোর জন্য)
      if (db) {
        db.collection('userStats')
          .updateOne({ userId }, { $inc: { totalScreenshots: 1 } }, { upsert: true })
          .catch(e => console.log('userStats screenshot count persist error:', e.message));
      }

      if (isApproved(userId)) {
        incrementUserCount(userId);
      } else {
        await incrementTrialScreenshot(userId);
        const left = getTrialScreenshotLeft(userId);
        if (left === 0) {
          await bot.sendMessage(chatId,
            '⚠️ 𝗟𝗮𝘀𝘁 𝗙𝗿𝗲𝗲 𝗧𝗿𝗶𝗮𝗹 𝗦𝗰𝗿𝗲𝗲𝗻𝘀𝗵𝗼𝘁!\n\n' +
            '🔓 𝗩𝗲𝗿𝗶𝗳𝘆 𝘆𝗼𝘂𝗿 𝗮𝗰𝗰𝗼𝘂𝗻𝘁 𝘁𝗼 𝘂𝗻𝗹𝗼𝗰𝗸 𝗨𝗻𝗹𝗶𝗺𝗶𝘁𝗲𝗱 𝗔𝗰𝗰𝗲𝘀𝘀.',
            { parse_mode: 'Markdown' }
          );
        }
      }

      const remainingCount = userId === ADMIN_ID
        ? '∞'
        : isApproved(userId)
          ? String(5 - getUserCount(userId))
          : String(getTrialScreenshotLeft(userId));

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
        '🕒 𝗘𝗡𝗧𝗥𝗬     ➜ ' + entry + '\n' +
        '⏳ 𝗘𝗫𝗣𝗜𝗥𝗬    ➜ ' + expiry + '\n\n' +
        '━━━━━━━━━━━━━━━━\n\n' +
        '🎯 𝗖𝗢𝗡𝗙𝗜𝗗𝗘𝗡𝗖𝗘 ➜ ' + signal.confidence + ' ' + confEmoji + ' (' + signal.winProbability + ')\n' +
        scoreLine +
        '📊 𝗧𝗥𝗘𝗡𝗗 ➜ ' + signal.trend + '\n' +
        '🏆 𝗦𝗘𝗧𝗨𝗣 ➜ ' + signal.setupQuality + '\n\n' +
        '💡 𝗔𝗜 𝗩𝗜𝗘𝗪\n' +
        signal.reason + '\n\n' +
        '━━━━━━━━━━━━━━━━\n\n' +
        '📸 𝗦𝗰𝗿𝗲𝗲𝗻𝘀𝗵𝗼𝘁𝘀 𝗟𝗲𝗳𝘁: *' + remainingCount + '/5*\n\n' +
        '⚠️ 𝗠𝗮𝘅 𝟭 𝗦𝘁𝗲𝗽 𝗠𝗧𝗚',
        {
          parse_mode: 'Markdown',
          reply_markup: signalInlineKeyboard
        }
      );

      lastSignalMsgId.set(userId, sentMsg.message_id);

    } catch (e) {
      clearInterval(tickInterval);
      console.log('ERROR:', e.message);
      try { await bot.deleteMessage(chatId, loadMsg.message_id); } catch (err) {}

      if (e.message === 'ANALYSIS_TIMEOUT') {
        await bot.sendMessage(chatId,
          '⏱️ 𝗔𝗻𝗮𝗹𝘆𝘀𝗶𝘀 𝗧𝗼𝗼𝗸 𝗧𝗼𝗼 𝗟𝗼𝗻𝗴\n\n' +
          'AI সার্ভার এই মুহূর্তে ধীর সাড়া দিচ্ছে। অনুগ্রহ করে আবার চেষ্টা করুন।\n\n' +
          '➕ Tap 𝗚𝗲𝗻𝗲𝗿𝗮𝘁𝗲 𝗔𝗜 𝗦𝗶𝗴𝗻𝗮𝗹 📊',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      await bot.sendMessage(chatId,
        '⚠️ 𝗢𝗼𝗽𝘀! 𝗦𝗼𝗿𝗿𝘆 𝘀𝗼𝗺𝗲𝘁𝗵𝗶𝗻𝗴 𝘄𝗲𝗻𝘁 𝘄𝗿𝗼𝗻𝗴 𝘄𝗵𝗶𝗹𝗲 𝗮𝗻𝗮𝗹𝘆𝘇𝗶𝗻𝗴 𝘁𝗵𝗲 𝗰𝗵𝗮𝗿𝘁.\n\n' +
        '🔄 𝗣𝗹𝗲𝗮𝘀𝗲 𝘁𝗿𝘆 𝗮𝗴𝗮𝗶𝗻 𝗶𝗻 𝗮 𝗳𝗲𝘄 𝘀𝗲𝗰𝗼𝗻𝗱𝘀.\n\n' +
        '➕ Tap 𝗚𝗲𝗻𝗲𝗿𝗮𝘁𝗲 𝗔𝗜 𝗦𝗶𝗴𝗻𝗮𝗹 📊',
        { parse_mode: 'Markdown' }
      );
    }
  });
};
