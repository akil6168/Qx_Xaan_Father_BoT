// learner.js - Unified Signal Result Logger + Daily/Weekly Learning Reports
//
// এই ফাইলটাই একমাত্র জায়গা যেখানে বটের সব সিগন্যাল-উৎস (index.js এর ম্যানুয়াল
// signal, session.js এর channel session, channel.js এর আলাদা channel broadcast,
// আর screenshot.js এর chart analysis) তাদের win/loss ফলাফল জমা দেয়। সব একই
// MongoDB collection-এ (signalResults — index.js যেটা আগে থেকেই ব্যবহার করছিল)
// `source` ফিল্ড দিয়ে আলাদা হয়ে জমা হয়, যাতে বট বুঝতে পারে কোন pair/filter/source
// আসলে সবচেয়ে reliable — আর admin কে প্রতিদিন + প্রতি সপ্তাহে report যায়।
//
// ব্যবহার:
//   const learner = require('./learner');
//   learner.init(db);                 // index.js এ connectDB() এর পরপর একবার
//   learner.startScheduler(bot);       // একবার, admin কে daily/weekly report পাঠানোর জন্য
//   learner.logResult({ source: 'channel', symbol, direction, entryPrice, exitPrice,
//                       finalResult: 'DIRECT_WIN' | 'MTG_WIN' | 'FINAL_LOSS' | 'UNVERIFIED', ... });

const ADMIN_ID = 5724602667;

let dbRef = null;
let schedulerStarted = false;
let lastDailyReportKey = null;
let lastWeeklyReportKey = null;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🛠️ HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function getBDTime() {
  const bd = new Date(Date.now() + 6 * 60 * 60 * 1000);
  const h = bd.getUTCHours(), m = bd.getUTCMinutes(), s = bd.getUTCSeconds();
  return {
    h, m, s,
    dow: bd.getUTCDay(), // 0 = রবিবার
    dateKey: `${bd.getUTCFullYear()}-${String(bd.getUTCMonth() + 1).padStart(2, '0')}-${String(bd.getUTCDate()).padStart(2, '0')}`,
    weekKey: getISOWeekKey(bd),
    fullTime: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  };
}

function getISOWeekKey(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function startOfTodayBD() {
  const bd = new Date(Date.now() + 6 * 60 * 60 * 1000);
  const startBD = Date.UTC(bd.getUTCFullYear(), bd.getUTCMonth(), bd.getUTCDate());
  return new Date(startBD - 6 * 60 * 60 * 1000); // BD মধ্যরাতকে ফিরিয়ে UTC-তে আনা
}

// ✅ নতুন — Daily Report বাগ ফিক্সের জন্য গতকালের শুরুর সময় (BD)
function startOfYesterdayBD() {
  return new Date(startOfTodayBD().getTime() - 24 * 60 * 60 * 1000);
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

function isWinResult(finalResult) {
  return finalResult === 'DIRECT_WIN' || finalResult === 'MTG_WIN';
}
function isLossResult(finalResult) {
  return finalResult === 'FINAL_LOSS';
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ✅ INIT — index.js এর connectDB() সফল হওয়ার পরপর একবার কল করতে হবে
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function init(db) {
  dbRef = db;
  console.log('✅ learner.js connected to MongoDB (signalResults collection)');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ✅ LOG RESULT — যেকোনো source থেকে normalized record পাঠালেই যথেষ্ট
//
// record = {
//   source: 'index' | 'session' | 'channel' | 'screenshot',
//   userId: number | null,
//   symbol: string,
//   direction: 'UP' | 'DOWN' | 'UP⏫' | 'DOWN⏬',
//   entryTime: string | null,
//   entryPrice: number | null,
//   exitPrice: number | null,
//   directResult: 'WIN' | 'LOSS' | null,
//   mtgResult: 'WIN' | 'LOSS' | null,
//   finalResult: 'DIRECT_WIN' | 'MTG_WIN' | 'FINAL_LOSS' | 'UNVERIFIED' | 'UNKNOWN',
//   aiScore: number | null,
//   signals: string[] | null,   // কোন indicator/filter গুলো এই সিদ্ধান্তে অবদান রেখেছে
//   isLive: boolean | null
// }
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function logResult(record) {
  if (!dbRef) {
    console.log('⚠️ learner.logResult called before init() — record dropped:', record.source, record.symbol);
    return;
  }
  try {
    await dbRef.collection('signalResults').insertOne({
      source: record.source || 'unknown',
      userId: record.userId || null,
      symbol: record.symbol || null,
      direction: record.direction || null,
      entryTime: record.entryTime || null,
      entryPrice: typeof record.entryPrice === 'number' ? record.entryPrice : null,
      exitPrice: typeof record.exitPrice === 'number' ? record.exitPrice : null,
      directResult: record.directResult || null,
      mtgResult: record.mtgResult || null,
      finalResult: record.finalResult || 'UNKNOWN',
      aiScore: typeof record.aiScore === 'number' ? record.aiScore : null,
      signals: Array.isArray(record.signals) ? record.signals.slice(0, 10) : null,
      isLive: typeof record.isLive === 'boolean' ? record.isLive : null,
      createdAt: new Date()
    });
  } catch (e) {
    console.log('⚠️ learner.logResult insert error:', e.message);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 📊 AGGREGATE REPORTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function buildReport(sinceDate, title, untilDate) {
  if (!dbRef) return `⚠️ ${title} — DB এখনো রেডি না।`;

  const query = { finalResult: { $in: ['DIRECT_WIN', 'MTG_WIN', 'FINAL_LOSS'] } };
  query.createdAt = untilDate ? { $gte: sinceDate, $lt: untilDate } : { $gte: sinceDate };

  const records = await dbRef.collection('signalResults')
    .find(query)
    .toArray();

  if (records.length === 0) {
    return `📊 ${toBoldSans(title)}\n\nএই সময়ে কোনো সম্পূর্ণ (verified) সিগন্যাল পাওয়া যায়নি।`;
  }

  const total = records.length;
  const wins = records.filter(r => isWinResult(r.finalResult)).length;
  const directWins = records.filter(r => r.finalResult === 'DIRECT_WIN').length;
  const mtgWins = records.filter(r => r.finalResult === 'MTG_WIN').length;
  const losses = records.filter(r => isLossResult(r.finalResult)).length;
  const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : '0.0';

  const bySource = {};
  for (const r of records) {
    const s = r.source || 'unknown';
    if (!bySource[s]) bySource[s] = { total: 0, wins: 0 };
    bySource[s].total++;
    if (isWinResult(r.finalResult)) bySource[s].wins++;
  }
  let sourceText = '';
  for (const [src, d] of Object.entries(bySource)) {
    const rate = d.total > 0 ? ((d.wins / d.total) * 100).toFixed(1) : '0.0';
    sourceText += `  • ${src}: ${rate}% (${d.wins}/${d.total})\n`;
  }

  const byPair = {};
  for (const r of records) {
    const p = r.symbol || 'unknown';
    if (!byPair[p]) byPair[p] = { total: 0, wins: 0 };
    byPair[p].total++;
    if (isWinResult(r.finalResult)) byPair[p].wins++;
  }
  const sortedPairs = Object.entries(byPair).sort((a, b) => b[1].total - a[1].total).slice(0, 5);
  let pairText = '';
  for (const [pair, d] of sortedPairs) {
    const rate = d.total > 0 ? ((d.wins / d.total) * 100).toFixed(1) : '0.0';
    pairText += `  • ${pair}: ${rate}% (${d.wins}/${d.total})\n`;
  }

  return (
    `📊 ${toBoldSans(title)}\n\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `📈 ${toBoldSans('TOTAL')}: ${total}\n` +
    `✅ ${toBoldSans('WINS')}: ${wins} (Direct: ${directWins}, MTG: ${mtgWins})\n` +
    `❌ ${toBoldSans('LOSSES')}: ${losses}\n` +
    `🎯 ${toBoldSans('WIN RATE')}: ${winRate}%\n` +
    `━━━━━━━━━━━━━━━━━━━\n\n` +
    `📊 ${toBoldSans('BY SOURCE')}\n${sourceText || '  কোনো ডেটা নেই\n'}\n` +
    `📊 ${toBoldSans('TOP PAIRS')}\n${pairText || '  কোনো ডেটা নেই\n'}\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `🤖 ${toBoldSans('QX AI LEARNER')}`
  );
}

async function getDailyReport() {
  // ✅ ফিক্স — scheduler রাত ১২:০৫-১২:০৯ BD-তে চলে, ততক্ষণে নতুন দিন শুরু হয়ে গেছে।
  // আগে startOfTodayBD() ব্যবহার হতো, যেটা "আজ" মানে নতুন (প্রায় খালি) দিনকে ধরত আর
  // পুরো গতকালের signalResults বাদ পড়ে যেত (তাই সবসময় "কোনো সিগন্যাল পাওয়া যায়নি")।
  // এখন গতকাল ০০:০০ থেকে আজ ০০:০০ (BD) — এই বদ্ধ রেঞ্জ ব্যবহার হচ্ছে।
  return buildReport(startOfYesterdayBD(), 'DAILY LEARNING REPORT', startOfTodayBD());
}

async function getWeeklyReport() {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  return buildReport(sevenDaysAgo, 'WEEKLY LEARNING REPORT');
}

// ✅ session.js এর পুরনো (stats.json ভিত্তিক) getStatsMessage() এর বদলি — এখন Mongo থেকে আসে
async function getStatsMessage() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return buildReport(thirtyDaysAgo, 'QX AI PERFORMANCE (Last 30 Days)');
}

// ✅ channel.js এর পুরনো in-memory dailyStats এর বদলি — শুধু একটা source-এর আজকের total/wins/losses
async function getSourceDailyStats(source) {
  if (!dbRef) return null;
  const records = await dbRef.collection('signalResults')
    .find({
      createdAt: { $gte: startOfTodayBD() },
      source,
      finalResult: { $in: ['DIRECT_WIN', 'MTG_WIN', 'FINAL_LOSS'] }
    })
    .toArray();
  const total = records.length;
  const wins = records.filter(r => isWinResult(r.finalResult)).length;
  const losses = total - wins;
  return { total, wins, losses };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ⏰ SCHEDULER — daily report ~00:05-00:09 BD, weekly report রবিবার ~00:10-00:14 BD
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function startScheduler(bot) {
  if (schedulerStarted) return;
  schedulerStarted = true;

  setInterval(async () => {
    try {
      const { h, m, dow, dateKey, weekKey } = getBDTime();

      if (h === 0 && m >= 5 && m <= 9 && lastDailyReportKey !== dateKey) {
        lastDailyReportKey = dateKey;
        try {
          const report = await getDailyReport();
          await bot.sendMessage(ADMIN_ID, report, { parse_mode: 'Markdown' });
          console.log('📊 learner.js daily report sent for', dateKey);
        } catch (e) { console.log('learner daily report send error:', e.message); }
      }

      if (dow === 0 && h === 0 && m >= 10 && m <= 14 && lastWeeklyReportKey !== weekKey) {
        lastWeeklyReportKey = weekKey;
        try {
          const report = await getWeeklyReport();
          await bot.sendMessage(ADMIN_ID, report, { parse_mode: 'Markdown' });
          console.log('📊 learner.js weekly report sent for', weekKey);
        } catch (e) { console.log('learner weekly report send error:', e.message); }
      }
    } catch (e) {
      console.log('learner.js scheduler error:', e.message);
    }
  }, 60 * 1000);

  console.log('✅ learner.js scheduler started (daily ~00:05 BD, weekly রবিবার ~00:10 BD)');
}

module.exports = {
  init,
  logResult,
  getDailyReport,
  getWeeklyReport,
  getStatsMessage,
  getSourceDailyStats,
  startScheduler
};
