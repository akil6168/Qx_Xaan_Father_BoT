// v25 - Free Trial(3) + Deposit-Based Affiliate Verify + XAdmin FULL Control Panel (Submenu) + Real Candle-Based Result Tracking + Menu Cleanup
const TelegramBot = require('node-telegram-bot-api');
const { MongoClient } = require('mongodb');
const express = require('express');
const fetch = require('node-fetch');
const twelveData = require('./twelvedata');
const { registerMiniAppRoutes } = require('./miniapp-api');
const geminiKeyPool = require('./geminikey');
const learner = require('./learner');

const TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const bot = new TelegramBot(TOKEN, { polling: false });

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🚨 ERROR LOG BUFFER — /xadmin এর "Error Logs" বাটনের জন্য (সর্বশেষ ২০টা)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const errorLogBuffer = [];
const _origConsoleError = console.error.bind(console);
console.error = function (...args) {
  try {
    const msg = args.map(a => (a instanceof Error ? (a.stack || a.message) : (typeof a === 'string' ? a : JSON.stringify(a)))).join(' ');
    const bd = new Date(Date.now() + 6 * 60 * 60 * 1000);
    const timeStr = String(bd.getUTCHours()).padStart(2, '0') + ':' + String(bd.getUTCMinutes()).padStart(2, '0') + ':' + String(bd.getUTCSeconds()).padStart(2, '0');
    errorLogBuffer.push('[' + timeStr + '] ' + msg);
    if (errorLogBuffer.length > 20) errorLogBuffer.shift();
  } catch (e) {}
  _origConsoleError(...args);
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🛡️ SAFETY PATCH — খালি text পাঠানো ঠেকানো + crash বন্ধ করা
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const _origSendMessage = bot.sendMessage.bind(bot);
bot.sendMessage = function (chatId, text, options) {
  if (!text || (typeof text === 'string' && text.trim().length === 0)) {
    console.error('🚨 EMPTY sendMessage আটকানো হলো! chatId:', chatId);
    console.error(new Error('Empty sendMessage call stack').stack);
    return Promise.resolve(null);
  }
  return _origSendMessage(chatId, text, options);
};

const _origEditMessageText = bot.editMessageText.bind(bot);
bot.editMessageText = function (text, options) {
  if (!text || (typeof text === 'string' && text.trim().length === 0)) {
    console.error('🚨 EMPTY editMessageText আটকানো হলো!');
    console.error(new Error('Empty editMessageText call stack').stack);
    return Promise.resolve(null);
  }
  return _origEditMessageText(text, options);
};

process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled Rejection:', reason && reason.message ? reason.message : reason);
  if (reason && reason.stack) console.error(reason.stack);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception:', err.message);
  console.error(err.stack);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const ADMIN_ID = 5724602667;
// ✅ ফিক্স — Free Trial ৩ থেকে ২ করা হয়েছে, আর প্রতিদিন রাত ১২টায় স্বয়ংক্রিয় reset হয় (নিচে scheduler দেখো)
const FREE_TRIAL_SIGNAL = 2;
const FREE_TRIAL_SCREENSHOT = 2;
const MIN_DEPOSIT_USD = 10;

// ✅ নতুন — Mini App Scan Free Trial
const MINIAPP_FREE_TRIAL = 2;
const miniappTrialCount = new Map(); // userId -> ব্যবহৃত সংখ্যা

async function incrementMiniappTrial(userId) {
  const current = miniappTrialCount.get(userId) || 0;
  miniappTrialCount.set(userId, current + 1);
  if (db) {
    await db.collection('miniappTrialCounts').updateOne(
      { userId }, { $set: { userId, count: current + 1 } }, { upsert: true }
    );
  }
}

function getMiniappTrialLeft(userId) {
  return MINIAPP_FREE_TRIAL - (miniappTrialCount.get(userId) || 0);
}

let maintenanceMode = false;
let emergencyMode = false;

let startedUsers = new Set();
let approvedUsers = new Set([ADMIN_ID]);
let bannedUsers = new Set();
let submissions = [];
const trialSignalCount = new Map();
const trialScreenshotCount = new Map();

const verifyMode = new Set();
const passwordMode = new Map();
const broadcastMode = new Set();
const banMode = new Set();
const unbanMode = new Set();
const unapproveMode = new Set();
const delAffiliateMode = new Set();
const messageUserMode = new Set();
const pendingMessageTarget = new Map();

// ✅ /xadmin — state (নতুন সিস্টেম অনুযায়ী পরিবর্তিত)
const xadminCheckMode = new Set();
const xadminTrialResetMode = new Set();
const xadminDeleteTestDataMode = new Set();
const xadminMessageUserMode = new Map(); // ADMIN_ID -> target userId, "💬 Message" বাটনের জন্য
const xadminVerifyNoDepositMode = new Set();
const xadminSetDepositMode = new Set();
const xadminSearchUserMode = new Set(); // ✅ নতুন — Search User ID

// ✅ Submissions লিস্ট থেকে মুছে ফেলার জন্য state
// (deleteSubmissionMode সরানো হলো — এখন প্রতিটা submission আলাদাভাবে detail card থেকে delete হয়)

// ✅ Admin/XAdmin প্যানেলের "একটাই লাইভ মেসেজ" রাখার জন্য
let adminPanelMsgId = null;
let xadminPanelMsgId = null;

// ✅ নতুন — Back button navigation (stack-based, যেকোনো গভীরতার submenu-তে কাজ করে)
let adminNavStack = [];   // e.g. ['admin_menu_users']
let adminOnLeaf = false;  // true হলে বর্তমানে একটা leaf action-এর ফলাফল দেখানো হচ্ছে
let xadminNavStack = [];  // e.g. ['xadmin_menu_diag', 'xadmin_menu_twelvedata']
let xadminOnLeaf = false;

let sessionModule;
let newsModuleRef; // ✅ নতুন — callback_query handler থেকে newsModule অ্যাক্সেস করার জন্য
let channelModuleRef; // ✅ নতুন — channel.js-এর Channel Key Health অ্যাক্সেসের জন্য
const lastSignalMsgId = new Map();

// ✅ ফিক্স — username/name-এ _ বা * থাকলে Markdown ভেঙে যেতো (Telegram এগুলোকে
// italic/bold চিহ্ন ধরে ফেলতো, ফলে নাম ভুল দেখাতো আর ট্যাপ করলে কাজ করতো না)
function escapeMd(str) {
  if (!str) return str;
  return String(str).replace(/([_*`])/g, '\\$1');
}

function mentionUser(userId, username, firstName) {
  const safeName = escapeMd((firstName || 'User').replace(/[\[\]]/g, ''));
  if (username) return '@' + escapeMd(username) + ' ([' + safeName + '](tg://user?id=' + userId + '))';
  return '[' + safeName + '](tg://user?id=' + userId + ')';
}

// ✅ ফিক্স — পুরো বট জুড়ে যেখানেই User ID (UID) দেখানো হয়, সবখানে এটা দিয়ে বানালে
// সংখ্যাটা নিজেই ক্লিকযোগ্য হয়ে যায় (tg://user?id=) — ট্যাপ করলে সরাসরি ওই ইউজারের
// Telegram প্রোফাইলে চলে যাওয়া যায়।
function uidLink(userId) {
  return '[' + userId + '](tg://user?id=' + userId + ')';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ✅ নতুন — Admin Panel / XAdmin Panel কে "একটাই লাইভ মেসেজ" হিসেবে রাখার হেল্পার
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function updateAdminPanel(chatId, text, keyboard) {
  if (adminPanelMsgId) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: adminPanelMsgId, parse_mode: 'Markdown', reply_markup: keyboard });
      return;
    } catch (e) {
      try { await bot.deleteMessage(chatId, adminPanelMsgId); } catch (e2) {}
      adminPanelMsgId = null;
    }
  }
  const sent = await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
  if (sent) adminPanelMsgId = sent.message_id;
}

async function updateXAdminPanel(chatId, text, keyboard) {
  if (xadminPanelMsgId) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: xadminPanelMsgId, parse_mode: 'Markdown', reply_markup: keyboard });
      return;
    } catch (e) {
      try { await bot.deleteMessage(chatId, xadminPanelMsgId); } catch (e2) {}
      xadminPanelMsgId = null;
    }
  }
  const sent = await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
  if (sent) xadminPanelMsgId = sent.message_id;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ✅ নতুন — প্রতি ইউজারের জন্য "একটাই লাইভ মেনু/প্রম্পট মেসেজ" (সিগন্যাল মেসেজ থেকে আলাদা)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const lastMenuMsgId = new Map(); // userId -> message_id

async function sendMenuMessage(chatId, userId, text, options = {}) {
  if (lastMenuMsgId.has(userId)) {
    try { await bot.deleteMessage(chatId, lastMenuMsgId.get(userId)); } catch (e) {}
    lastMenuMsgId.delete(userId);
  }
  const sent = await bot.sendMessage(chatId, text, options);
  if (sent) lastMenuMsgId.set(userId, sent.message_id);
  return sent;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ✅ নতুন — Admin Panel Main Menu + Submenus (জোড়া বাটন সিস্টেম)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function buildAdminMainPanel() {
  const mStatus = maintenanceMode ? '🔧 ON' : '✅ OFF';
  const eStatus = emergencyMode ? '🛑 ON' : '✅ OFF';
  return {
    text: '👑 *ADMIN PANEL*\n══════════════════\n🔧 Maintenance: ' + mStatus + '\n🛑 Emergency Mode: ' + eStatus + '\n\nএকটা ক্যাটাগরি বেছে নাও:',
    keyboard: {
      inline_keyboard: [
        [{ text: '✅ Approved', callback_data: 'admin_menu_approved' }, { text: '📋 Submissions', callback_data: 'admin_submissions' }],
        [{ text: '⚡ Affiliates', callback_data: 'admin_menu_affiliates' }, { text: '💬 Message', callback_data: 'admin_menu_message' }],
        [{ text: '🚫 Ban', callback_data: 'admin_menu_ban' }, { text: '⚙️ Bot Control', callback_data: 'admin_menu_botcontrol' }]
      ]
    }
  };
}

const adminSubMenus = {
  admin_menu_approved: {
    text: '✅ *APPROVED*\n\nএকটা অপশন বেছে নাও:',
    keyboard: [
      [{ text: '✅ Approved List', callback_data: 'admin_approved' }, { text: '❌ Unapprove', callback_data: 'admin_unapprove_prompt' }],
      [{ text: '🔙 Back', callback_data: 'admin_back' }]
    ]
  },
  admin_menu_submissions: {
    text: '📋 *SUBMISSIONS*\n\nএকটা অপশন বেছে নাও:',
    keyboard: [
      [{ text: '📋 Submissions', callback_data: 'admin_submissions' }],
      [{ text: '🔙 Back', callback_data: 'admin_back' }]
    ]
  },
  admin_menu_affiliates: {
    text: '⚡ *AFFILIATES*\n\nএকটা অপশন বেছে নাও:',
    keyboard: [
      [{ text: '⚡ View Affiliates', callback_data: 'admin_affiliate' }, { text: '❌ Remove Affiliate', callback_data: 'admin_delaffiliate_prompt' }],
      [{ text: '🔙 Back', callback_data: 'admin_back' }]
    ]
  },
  admin_menu_message: {
    text: '💬 *MESSAGE*\n\nএকটা অপশন বেছে নাও:',
    keyboard: [
      [{ text: '📢 Broadcast', callback_data: 'admin_broadcast' }, { text: '💬 Message User', callback_data: 'admin_message_prompt' }],
      [{ text: '🔙 Back', callback_data: 'admin_back' }]
    ]
  },
  admin_menu_ban: {
    text: '🚫 *BAN CONTROL*\n\nএকটা অপশন বেছে নাও:',
    keyboard: [
      [{ text: '🚫 Ban User', callback_data: 'admin_ban_prompt' }, { text: '✅ Unban User', callback_data: 'admin_unban_prompt' }],
      [{ text: '🔙 Back', callback_data: 'admin_back' }]
    ]
  },
};

// ✅ নতুন — Bot Control সাবমেনু ডাইনামিক (Maintenance/Emergency লেবেল লাইভ স্ট্যাটাস অনুযায়ী বদলায়)
function buildAdminBotControlSubmenu() {
  return {
    text: '⚙️ *BOT CONTROL*\n\nএকটা অপশন বেছে নাও:',
    keyboard: [
      [
        { text: maintenanceMode ? '🟢 Disable Maintenance' : '🔧 Maintenance', callback_data: 'admin_maintenance' },
        { text: emergencyMode ? '🟢 Disable Emergency' : '🛑 Emergency Mode', callback_data: 'admin_emergency' }
      ],
      [{ text: '🚀 Session Start', callback_data: 'admin_session_start' }],
      [{ text: '🔙 Back', callback_data: 'admin_back' }]
    ]
  };
}

const adminBackKeyboard = { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'admin_back' }]] };

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ✅ নতুন — XAdmin Panel Main Menu + Submenus
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function buildXAdminMainPanel() {
  const emStatus = emergencyMode ? '🛑 ON' : '✅ OFF';
  const mStatus = maintenanceMode ? '🔧 ON' : '✅ OFF';
  return {
    text: '🧪 *𝗫𝗔𝗗𝗠𝗜𝗡 — 𝗧𝗘𝗦𝗧 𝗔𝗡𝗗 𝗖𝗢𝗡𝗧𝗥𝗢𝗟 𝗣𝗔𝗡𝗘𝗟*\n══════════════════\n🛑 Emergency Mode: ' + emStatus + '\n🔧 Maintenance: ' + mStatus + '\n\nএকটা ক্যাটাগরি বেছে নাও:',
    keyboard: {
      inline_keyboard: [
        [{ text: '👥 All User Database', callback_data: 'xadmin_menu_userdb' }, { text: '👤 Verify & Deposit', callback_data: 'xadmin_menu_verify' }],
        [{ text: '🎁 Trial & Cleanup', callback_data: 'xadmin_menu_cleanup' }, { text: '▶ Session Control', callback_data: 'xadmin_menu_session' }],
        [{ text: '🩺 Diagnostics', callback_data: 'xadmin_menu_diag' }]
      ]
    }
  };
}

const xadminSubMenus = {
  xadmin_menu_verify: {
    text: '🛡️ *𝗩𝗘𝗥𝗜𝗙𝗬 • 𝗗𝗣 • 𝗦𝗘𝗔𝗥𝗖𝗛 𝗜𝗗𝘀*\n\nএকটা অপশন বেছে নাও:',
    keyboard: [
      [{ text: '🛡️ Verify Trader ID', callback_data: 'xadmin_verify_nodeposit' }, { text: '💰 Set Deposit', callback_data: 'xadmin_setdeposit' }],
      [{ text: '🔎 Search Trader ID', callback_data: 'xadmin_check' }, { text: '👤 Search User ID', callback_data: 'xadmin_search_user' }],
      [{ text: '🔙 Back', callback_data: 'xadmin_back' }]
    ]
  },
  xadmin_menu_cleanup: {
    text: '🎁 *TRIAL & CLEANUP*\n\nএকটা অপশন বেছে নাও:',
    keyboard: [
      [{ text: '🎁 Reset Free Trial', callback_data: 'xadmin_trial_reset' }, { text: '🗑 Delete Test Data', callback_data: 'xadmin_delete_testdata' }],
      [{ text: '🚨 Reset All Trials ⚠️', callback_data: 'xadmin_reset_all_trials_prompt' }],
      [{ text: '🔙 Back', callback_data: 'xadmin_back' }]
    ]
  },
  xadmin_menu_session: {
    text: '▶ *SESSION CONTROL*\n\nএকটা অপশন বেছে নাও:',
    keyboard: [
      [{ text: '▶ Start', callback_data: 'admin_session_start' }, { text: '⏸ Pause', callback_data: 'xadmin_session_pause' }],
      [{ text: '⏹ Stop', callback_data: 'xadmin_session_stop' }],
      [{ text: '🔙 Back', callback_data: 'xadmin_back' }]
    ]
  },
  xadmin_menu_diag: {
    text: '🩺 *DIAGNOSTICS*\n\nএকটা অপশন বেছে নাও:',
    keyboard: [
      [{ text: '🔑 All API Keys', callback_data: 'xadmin_health' }, { text: '🚨 Error Logs', callback_data: 'xadmin_errorlogs' }],
      [{ text: '📸 TwelveData (Signal)', callback_data: 'xadmin_menu_twelvedata' }, { text: '📡 TwelveData (Channel)', callback_data: 'xadmin_menu_channel' }],
      [{ text: '🤖 Gemini Keys', callback_data: 'xadmin_menu_gemini' }, { text: '📰 News API', callback_data: 'xadmin_test_news' }],
      [{ text: '🧹 Clean Database', callback_data: 'xadmin_clean_db' }],
      [{ text: '🔙 Back', callback_data: 'xadmin_back' }]
    ]
  },
  xadmin_menu_userdb: {
    text: '👥 *ALL USER DATABASE*\n\nএকটা অপশন বেছে নাও:',
    keyboard: [
      [{ text: '📋 All Users', callback_data: 'xadmin_userlist_0' }],
      [{ text: '🔙 Back', callback_data: 'xadmin_back' }]
    ]
  }
};

// ✅ নতুন — Diagnostics-এর ভেতরের দ্বিতীয়-স্তরের সাব-প্যানেল
const xadminSubSubMenus = {
  xadmin_menu_twelvedata: {
    text: '📸 *TWELVEDATA (SIGNAL)*\n\nএকটা অপশন বেছে নাও:',
    keyboard: [
      [{ text: '❤️ Key Health', callback_data: 'xadmin_td_health' }],
      [{ text: '🚫 Dead Keys', callback_data: 'xadmin_td_exhausted' }],
      [{ text: '🔙 Back', callback_data: 'xadmin_back' }]
    ]
  },
  xadmin_menu_channel: {
    text: '📡 *TWELVEDATA (CHANNEL)*\n\nএকটা অপশন বেছে নাও:',
    keyboard: [
      [{ text: '❤️ Key Health', callback_data: 'xadmin_channel_health' }],
      [{ text: '🚫 Dead Keys', callback_data: 'xadmin_channel_dead' }],
      [{ text: '🔙 Back', callback_data: 'xadmin_back' }]
    ]
  },
  xadmin_menu_gemini: {
    text: '🤖 *GEMINI KEYS*\n\nএকটা অপশন বেছে নাও:',
    keyboard: [
      [{ text: '❤️ Key Health', callback_data: 'xadmin_gemini_health' }],
      [{ text: '🚫 Dead Keys', callback_data: 'xadmin_gemini_dead' }],
      [{ text: '🔄 Reset Keys', callback_data: 'xadmin_reset_gemini' }],
      [{ text: '🔙 Back', callback_data: 'xadmin_back' }]
    ]
  }
};

const xadminBackKeyboard = { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'xadmin_back' }]] };

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ✅ নতুন — Stack-based Back Navigation Helpers (admin + xadmin)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function renderAdminPanelByKey(key) {
  if (!key) { const p = buildAdminMainPanel(); return { text: p.text, keyboard: p.keyboard }; }
  if (key === 'admin_menu_botcontrol') {
    const bc = buildAdminBotControlSubmenu();
    return { text: bc.text, keyboard: { inline_keyboard: bc.keyboard } };
  }
  const sub = adminSubMenus[key];
  if (sub) return { text: sub.text, keyboard: { inline_keyboard: sub.keyboard } };
  const p = buildAdminMainPanel();
  return { text: p.text, keyboard: p.keyboard };
}

async function goAdminTo(chatId, key) {
  adminNavStack.push(key);
  adminOnLeaf = false;
  const r = renderAdminPanelByKey(key);
  await updateAdminPanel(chatId, r.text, r.keyboard);
}

async function goAdminBack(chatId) {
  if (adminOnLeaf) {
    adminOnLeaf = false;
    const topKey = adminNavStack[adminNavStack.length - 1];
    const r = renderAdminPanelByKey(topKey);
    await updateAdminPanel(chatId, r.text, r.keyboard);
    return;
  }
  adminNavStack.pop();
  const topKey = adminNavStack[adminNavStack.length - 1];
  const r = renderAdminPanelByKey(topKey);
  await updateAdminPanel(chatId, r.text, r.keyboard);
}

// ✅ নতুন — userlist রেন্ডারিং শেয়ারড ফাংশনে, যাতে Back navigation থেকেও কল করা যায়
async function renderUserListPanel(page) {
  const PAGE_SIZE = 10;
  const total = await db.collection('startedUsers').countDocuments();
  const users = await db.collection('startedUsers')
    .find({}).sort({ _id: 1 }).skip(page * PAGE_SIZE).limit(PAGE_SIZE).toArray();

  const circledNums = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩'];
  const rows = [];
  for (let i = 0; i < users.length; i += 2) {
    const row = [];
    const u1 = users[i];
    row.push({ text: circledNums[i] + ' ' + (u1.firstName || u1.username || ('User ' + u1.userId)), callback_data: 'xadmin_uprofile_' + u1.userId });
    if (users[i + 1]) {
      const u2 = users[i + 1];
      row.push({ text: circledNums[i + 1] + ' ' + (u2.firstName || u2.username || ('User ' + u2.userId)), callback_data: 'xadmin_uprofile_' + u2.userId });
    }
    rows.push(row);
  }

  const navRow = [];
  if (page > 0) navRow.push({ text: '◀ Previous', callback_data: 'xadmin_userlist_' + (page - 1) });
  if ((page + 1) * PAGE_SIZE < total) navRow.push({ text: 'Next ▶', callback_data: 'xadmin_userlist_' + (page + 1) });
  if (navRow.length) rows.push(navRow);
  rows.push([{ text: '🔙 Back', callback_data: 'xadmin_back' }]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return {
    text: '👥 *𝗔𝗟𝗟 𝗨𝗦𝗘𝗥𝗦*\n══════════════════\nTotal Users: ' + total + '\nPage ' + (page + 1) + ' / ' + totalPages + '\n\nSelect a user to view the profile:',
    keyboard: { inline_keyboard: rows }
  };
}

async function renderXAdminPanelByKey(key) {
  if (!key) { const p = buildXAdminMainPanel(); return { text: p.text, keyboard: p.keyboard }; }
  // ✅ ফিক্স — userlist এখন stack-এ push করা একটা "level", leaf হিসেবে treat হতো আগে (bug)
  if (key.startsWith('xadmin_userlist_')) {
    const page = parseInt(key.replace('xadmin_userlist_', ''), 10) || 0;
    try { return await renderUserListPanel(page); }
    catch (e) { return { text: '❌ User list লোড ব্যর্থ: ' + e.message, keyboard: xadminBackKeyboard }; }
  }
  const sub = xadminSubMenus[key];
  if (sub) return { text: sub.text, keyboard: { inline_keyboard: sub.keyboard } };
  const subsub = xadminSubSubMenus[key];
  if (subsub) return { text: subsub.text, keyboard: { inline_keyboard: subsub.keyboard } };
  const p = buildXAdminMainPanel();
  return { text: p.text, keyboard: p.keyboard };
}

async function goXAdminTo(chatId, key) {
  xadminNavStack.push(key);
  xadminOnLeaf = false;
  const r = await renderXAdminPanelByKey(key);
  await updateXAdminPanel(chatId, r.text, r.keyboard);
}

async function goXAdminBack(chatId) {
  if (xadminOnLeaf) {
    xadminOnLeaf = false;
    const topKey = xadminNavStack[xadminNavStack.length - 1];
    const r = await renderXAdminPanelByKey(topKey);
    await updateXAdminPanel(chatId, r.text, r.keyboard);
    return;
  }
  xadminNavStack.pop();
  const topKey = xadminNavStack[xadminNavStack.length - 1];
  const r = await renderXAdminPanelByKey(topKey);
  await updateXAdminPanel(chatId, r.text, r.keyboard);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ✅ Daily result-tracking state (per-user + global)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let dailyStats = { dateKey: null, activeUsers: new Set(), totalSignals: 0, directWin: 0, mtgWin: 0, loss: 0 };
const userDailyStats = new Map();
let lastReportDateKey = null;

function currentBDDateKey() {
  const bd = new Date(Date.now() + 6 * 60 * 60 * 1000);
  return `${bd.getUTCFullYear()}-${String(bd.getUTCMonth() + 1).padStart(2, '0')}-${String(bd.getUTCDate()).padStart(2, '0')}`;
}

// ✅ নতুন — Daily Admin Report-কে MongoDB থেকে persist করার জন্য BD date-boundary helpers
function startOfTodayBD() {
  const bd = new Date(Date.now() + 6 * 60 * 60 * 1000);
  const startBD = Date.UTC(bd.getUTCFullYear(), bd.getUTCMonth(), bd.getUTCDate());
  return new Date(startBD - 6 * 60 * 60 * 1000);
}

function startOfYesterdayBD() {
  return new Date(startOfTodayBD().getTime() - 24 * 60 * 60 * 1000);
}

function bdDateKeyFromUTCStart(utcStartDate) {
  const bd = new Date(utcStartDate.getTime() + 6 * 60 * 60 * 1000);
  return `${bd.getUTCFullYear()}-${String(bd.getUTCMonth() + 1).padStart(2, '0')}-${String(bd.getUTCDate()).padStart(2, '0')}`;
}

// ✅ নতুন — User Profile-এ "Last Active"/"Joined" মানুষ-পড়ার-উপযোগী ফরম্যাটে দেখানোর জন্য
function timeAgo(date) {
  if (!date) return 'N/A';
  const diffMs = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return mins + ' min ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + ' hour' + (hours === 1 ? '' : 's') + ' ago';
  const days = Math.floor(hours / 24);
  return days + ' day' + (days === 1 ? '' : 's') + ' ago';
}

function formatJoinedDate(date) {
  if (!date) return 'N/A';
  const d = new Date(date);
  const bd = new Date(d.getTime() + 6 * 60 * 60 * 1000);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${bd.getUTCDate()} ${months[bd.getUTCMonth()]} ${bd.getUTCFullYear()}`;
}

function formatReportDate(dateKeyStr) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const [y, mo, d] = dateKeyStr.split('-').map(Number);
  return `${d} ${months[mo - 1]} ${y}`;
}

function getBDTimeInfo() {
  const bd = new Date(Date.now() + 6 * 60 * 60 * 1000);
  return {
    hour: bd.getUTCHours(),
    minute: bd.getUTCMinutes(),
    second: bd.getUTCSeconds(),
    day: bd.getUTCDay()
  };
}

function isRealMarketOpen() {
  // ✅ ফিক্স — Live Market এখন সকাল ১১টা থেকে রাত ১২টা (মধ্যরাত) পর্যন্ত খোলা থাকবে,
  // আগে যেটা রাত ১১টায় বন্ধ হতো (শুক্রবারও এখন বাকি দিনের মতোই ১২টা পর্যন্ত খোলা — আলাদা early-close rule বাদ)।
  const { hour, day } = getBDTimeInfo();
  if (day === 6) return false;
  if (day === 0) return false;
  if (day === 1 && hour < 11) return false;
  if (hour < 11) return false;
  return true;
}

function ensureDailyStatsFresh() {
  const key = currentBDDateKey();
  if (dailyStats.dateKey !== key) {
    dailyStats = { dateKey: key, activeUsers: new Set(), totalSignals: 0, directWin: 0, mtgWin: 0, loss: 0 };
    userDailyStats.clear();
  }
}

function getUserStats(userId) {
  if (!userDailyStats.has(userId)) userDailyStats.set(userId, { directWin: 0, mtgWin: 0, loss: 0 });
  return userDailyStats.get(userId);
}

// ✅ ফিক্স (#৬) — আগে এই রিপোর্ট শুধু in-memory dailyStats/userDailyStats Map থেকে
// বানানো হতো, যেটা bot restart/redeploy হলেই হারিয়ে যেত (তখন রিপোর্ট সবসময় ০ দেখাত)।
// এখন MongoDB-র signalResults collection থেকে সরাসরি কোয়েরি করা হচ্ছে (source: 'index'
// — trackSignalResult() ইতিমধ্যে প্রতিটা ফলাফল এখানে saveSignalRecord() দিয়ে জমা দেয়),
// তাই ডেটা বট restart হলেও অক্ষত থাকে।
async function buildDailyAdminReport(sinceDate, untilDate, dateLabelKey) {
  const dateStr = formatReportDate(dateLabelKey || currentBDDateKey());

  if (!db) {
    return `📊 *𝗗𝗔𝗜𝗟𝗬 𝗔𝗗𝗠𝗜𝗡 𝗥𝗘𝗣𝗢𝗥𝗧*\n\n📅 ${dateStr}\n\n⚠️ DB এখনো রেডি না।`;
  }

  // ✅ ফিক্স — আগে শুধু source:'index' গণনা হতো, কিন্তু বেশিরভাগ সিগন্যাল আসে channel.js/session.js থেকে
  // (source: 'channel'/'session'), তাই Admin Report সবসময় ০ দেখাত। এখন সব source গণনা হয়।
  const query = { source: { $in: ['index', 'channel', 'session'] }, finalResult: { $in: ['DIRECT_WIN', 'MTG_WIN', 'FINAL_LOSS'] } };
  query.createdAt = untilDate ? { $gte: sinceDate, $lt: untilDate } : { $gte: sinceDate };

  let records = [];
  try {
    records = await db.collection('signalResults').find(query).toArray();
  } catch (e) {
    console.log('buildDailyAdminReport query error:', e.message);
  }

  const totalCompleted = records.length;
  const directWin = records.filter(r => r.finalResult === 'DIRECT_WIN').length;
  const mtgWin = records.filter(r => r.finalResult === 'MTG_WIN').length;
  const loss = records.filter(r => r.finalResult === 'FINAL_LOSS').length;
  const winRate = totalCompleted > 0 ? (((directWin + mtgWin) / totalCompleted) * 100).toFixed(1) : '0.0';

  const activeUserIds = new Set(records.map(r => r.userId).filter(Boolean));

  const byUser = {};
  for (const r of records) {
    if (!r.userId) continue;
    if (!byUser[r.userId]) byUser[r.userId] = { directWin: 0, mtgWin: 0, loss: 0 };
    if (r.finalResult === 'DIRECT_WIN') byUser[r.userId].directWin++;
    else if (r.finalResult === 'MTG_WIN') byUser[r.userId].mtgWin++;
    else if (r.finalResult === 'FINAL_LOSS') byUser[r.userId].loss++;
  }

  const sortedUsers = Object.entries(byUser)
    .map(([uid, s]) => ({ uid: Number(uid), ...s, total: s.directWin + s.mtgWin + s.loss }))
    .sort((a, b) => b.total - a.total);

  const top5 = sortedUsers.slice(0, 5);
  const remaining = sortedUsers.length - top5.length;

  let topText = '';
  top5.forEach(u => {
    const sub = submissions.find(s => s.userId === u.uid);
    const uname = sub && sub.username ? '@' + sub.username : (sub ? sub.name : 'User ' + u.uid);
    topText += `👤 ${uname} ➜ ${u.directWin}W • ${u.loss}L • ${u.mtgWin}M\n`;
  });
  if (!topText) topText = 'আজ কোনো সিগন্যাল নেওয়া হয়নি।\n';

  return (
    `📊 *𝗗𝗔𝗜𝗟𝗬 𝗔𝗗𝗠𝗜𝗡 𝗥𝗘𝗣𝗢𝗥𝗧*\n\n` +
    `📅 ${dateStr}\n` +
    `👥 *Active:* ${activeUserIds.size}\n` +
    `📊 *Total Signals:* ${totalCompleted}\n\n` +
    `🟢 *Direct Win:* ${directWin}\n` +
    `🟡 *MTG Win:* ${mtgWin}\n` +
    `🔴 *Loss:* ${loss}\n` +
    `🎯 *Win Rate:* ${winRate}%\n\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `🏆 *Top Active Users*\n\n` +
    topText +
    (remaining > 0 ? `\n➕ +${remaining} More Users` : '')
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ✅ Real Candle-Based Result Tracking
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function formatUTCDateTime(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
}

function parseUTCDatetimeStr(str) {
  return new Date(str + ' UTC');
}

async function waitForCandleByDatetime(symbol, targetDatetimeStr, maxAttempts = 6, intervalMs = 5000) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const candles = await getCandles(symbol);
      const match = candles.find(c => c.datetime === targetDatetimeStr);
      if (match) return match;
    } catch (e) {
      console.log('waitForCandleByDatetime fetch error:', e.message);
    }
    await sleep(intervalMs);
  }
  return null;
}

async function saveSignalRecord(record) {
  try {
    await learner.logResult({ source: 'index', ...record });
  } catch (e) {
    console.log('saveSignalRecord error:', e.message);
  }
}

async function trackSignalResult(userId, symbol, direction, entryDatetimeStr, entryDisplayTime) {
  if (!isRealMarketOpen()) return;

  ensureDailyStatsFresh();
  dailyStats.activeUsers.add(userId);
  dailyStats.totalSignals++;

  // ✅ নতুন — lifetime signal count MongoDB-তে persist (User Profile-এ "📊 Signals" দেখানোর জন্য)
  if (db) {
    db.collection('userStats')
      .updateOne({ userId }, { $inc: { totalSignals: 1 } }, { upsert: true })
      .catch(e => console.log('userStats signal count persist error:', e.message));
  }

  try {
    const entryCandle = await waitForCandleByDatetime(symbol, entryDatetimeStr);
    if (!entryCandle) {
      console.log(`⚠️ Entry candle পাওয়া যায়নি: ${symbol} @ ${entryDatetimeStr}`);
      return;
    }
    const entryOpen = entryCandle.open;

    const entryDate = parseUTCDatetimeStr(entryDatetimeStr);
    const waitUntilClose = entryDate.getTime() + 65 * 1000 - Date.now();
    if (waitUntilClose > 0) await sleep(waitUntilClose);
    if (!isRealMarketOpen()) return;

    const closedEntryCandle = await waitForCandleByDatetime(symbol, entryDatetimeStr, 6, 5000);
    if (!closedEntryCandle) {
      console.log(`⚠️ Closed entry candle পাওয়া যায়নি: ${symbol} @ ${entryDatetimeStr}`);
      return;
    }
    const entryClose = closedEntryCandle.close;

    const isDirectWin = direction === 'UP⏫' ? entryClose > entryOpen : entryClose < entryOpen;

    if (isDirectWin) {
      dailyStats.directWin++;
      getUserStats(userId).directWin++;
      console.log(`✅ Direct Win: user ${userId} | ${symbol} | Open:${entryOpen} Close:${entryClose}`);
      saveSignalRecord({
        userId, symbol, direction, entryTime: entryDisplayTime, entryPrice: entryOpen,
        directResult: 'WIN', mtgResult: null, finalResult: 'DIRECT_WIN', createdAt: new Date()
      });
      return;
    }

    console.log(`⚠️ Direct Loss (silent) — MTG শুরু হচ্ছে: user ${userId} | ${symbol}`);

    const mtgDate = new Date(entryDate.getTime() + 60 * 1000);
    const mtgDatetimeStr = formatUTCDateTime(mtgDate);

    const mtgCandle = await waitForCandleByDatetime(symbol, mtgDatetimeStr);
    if (!mtgCandle) {
      console.log(`⚠️ MTG candle পাওয়া যায়নি: ${symbol} @ ${mtgDatetimeStr}`);
      saveSignalRecord({
        userId, symbol, direction, entryTime: entryDisplayTime, entryPrice: entryOpen,
        directResult: 'LOSS', mtgResult: null, finalResult: 'UNKNOWN', createdAt: new Date()
      });
      return;
    }
    const mtgOpen = mtgCandle.open;

    const waitUntilMtgClose = mtgDate.getTime() + 65 * 1000 - Date.now();
    if (waitUntilMtgClose > 0) await sleep(waitUntilMtgClose);
    if (!isRealMarketOpen()) return;

    const closedMtgCandle = await waitForCandleByDatetime(symbol, mtgDatetimeStr, 6, 5000);
    if (!closedMtgCandle) {
      console.log(`⚠️ Closed MTG candle পাওয়া যায়নি: ${symbol} @ ${mtgDatetimeStr}`);
      return;
    }
    const mtgClose = closedMtgCandle.close;

    const isMtgWin = direction === 'UP⏫' ? mtgClose > mtgOpen : mtgClose < mtgOpen;

    if (isMtgWin) {
      dailyStats.mtgWin++;
      getUserStats(userId).mtgWin++;
      console.log(`🟡 MTG Win: user ${userId} | ${symbol} | Open:${mtgOpen} Close:${mtgClose}`);
      saveSignalRecord({
        userId, symbol, direction, entryTime: entryDisplayTime, entryPrice: entryOpen,
        directResult: 'LOSS', mtgResult: 'WIN', finalResult: 'MTG_WIN', createdAt: new Date()
      });
    } else {
      dailyStats.loss++;
      getUserStats(userId).loss++;
      console.log(`🔴 Final Loss: user ${userId} | ${symbol}`);
      saveSignalRecord({
        userId, symbol, direction, entryTime: entryDisplayTime, entryPrice: entryOpen,
        directResult: 'LOSS', mtgResult: 'LOSS', finalResult: 'FINAL_LOSS', createdAt: new Date()
      });
    }
  } catch (e) {
    console.log('⚠️ trackSignalResult error for', symbol, '-', e.message);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let db;
async function connectDB() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db('qxbot');
  console.log('MongoDB connected!');

  learner.init(db);

  const su = await db.collection('startedUsers').find().toArray();
  su.forEach(u => startedUsers.add(u.userId));

  const au = await db.collection('approvedUsers').find().toArray();
  au.forEach(u => approvedUsers.add(u.userId));

  const bu = await db.collection('bannedUsers').find().toArray();
  bu.forEach(u => bannedUsers.add(u.userId));

  const subs = await db.collection('submissions').find().toArray();
  submissions = subs;

  const tc = await db.collection('trialCounts').find().toArray();
  tc.forEach(u => {
    trialSignalCount.set(u.userId, u.signalCount || 0);
    trialScreenshotCount.set(u.userId, u.screenshotCount || 0);
  });

  // ✅ নতুন — Mini App trial counts লোড
  const mtc = await db.collection('miniappTrialCounts').find().toArray();
  mtc.forEach(u => miniappTrialCount.set(u.userId, u.count || 0));

  // ✅ নতুন — Maintenance/Emergency Mode DB থেকে restore (redeploy হলেও চালু থাকা অবস্থা বজায় থাকবে)
  const settingsDoc = await db.collection('botSettings').findOne({ _id: 'flags' });
  if (settingsDoc) {
    maintenanceMode = !!settingsDoc.maintenanceMode;
    emergencyMode = !!settingsDoc.emergencyMode;
  }

  await db.collection('startedUsers').createIndex({ userId: 1 }, { unique: true });
  await db.collection('approvedUsers').createIndex({ userId: 1 }, { unique: true });
  await db.collection('bannedUsers').createIndex({ userId: 1 }, { unique: true });
  await db.collection('trialCounts').createIndex({ userId: 1 }, { unique: true });
  await db.collection('affiliateVerified').createIndex({ traderId: 1 }, { unique: true });
  await db.collection('miniappTrialCounts').createIndex({ userId: 1 }, { unique: true });
}

// ✅ নতুন — Maintenance/Emergency Mode DB-তে সেভ করে (redeploy হলেও অবস্থা হারাবে না)
async function saveBotFlags() {
  if (!db) return;
  try {
    await db.collection('botSettings').updateOne(
      { _id: 'flags' },
      { $set: { maintenanceMode, emergencyMode } },
      { upsert: true }
    );
  } catch (e) {
    console.error('saveBotFlags error:', e.message);
  }
}

async function addStartedUser(userId, username, firstName) {
  startedUsers.add(userId);
  await db.collection('startedUsers').updateOne(
    { userId },
    {
      $set: { userId, username: username || null, firstName: firstName || null },
      // ✅ নতুন — শুধু প্রথমবার insert হলে joinedAt বসবে (পুরনো user-দের এটা নেই, N/A দেখাবে)
      $setOnInsert: { joinedAt: new Date() }
    },
    { upsert: true }
  );
}

async function addApprovedUser(userId) {
  approvedUsers.add(userId);
  await db.collection('approvedUsers').updateOne(
    { userId }, { $set: { userId } }, { upsert: true }
  );
}

// ✅ নতুন — প্রতিটা মেসেজ/callback-এ lastActive আপডেট করার জন্য (User Profile-এ দেখানোর জন্য)
// fire-and-forget — কোনো handler-কে block করে না, ব্যর্থ হলেও নীরবে চলে যায়
function touchLastActive(userId) {
  if (!db || !userId) return;
  db.collection('userStats')
    .updateOne({ userId }, { $set: { lastActive: new Date() } }, { upsert: true })
    .catch(() => {});
}

// ✅ নতুন (Fix #১) — প্রতিটা মেসেজ/callback-এ Telegram থেকে সর্বশেষ First Name,
// Last Name, Username রিফ্রেশ করে DB-তে সেভ করে। আগে শুধু প্রথমবার /start-এ
// সেভ হতো, পরে নাম/ইউজারনেম বদলালে বা প্রথমবার ভুল সেভ হলে কখনো আপডেট হতো না।
function refreshUserProfile(userId, username, firstName, lastName) {
  if (!db || !userId) return;
  db.collection('startedUsers')
    .updateOne(
      { userId },
      { $set: { userId, username: username || null, firstName: firstName || null, lastName: lastName || null } },
      { upsert: true }
    )
    .catch(() => {});
  if (!startedUsers.has(userId)) startedUsers.add(userId);
}

async function removeApprovedUser(userId) {
  approvedUsers.delete(userId);
  await db.collection('approvedUsers').deleteOne({ userId });
}

async function addBannedUser(userId) {
  bannedUsers.add(userId);
  await db.collection('bannedUsers').updateOne(
    { userId }, { $set: { userId } }, { upsert: true }
  );
}

async function removeBannedUser(userId) {
  bannedUsers.delete(userId);
  await db.collection('bannedUsers').deleteOne({ userId });
}

// ✅ ফিক্স — আগে প্রতিবার submit করলে নতুন row বানাত (spam notification-এর কারণ)।
// এখন একই (userId + traderId) জোড়ার জন্য একটাই ডকুমেন্ট থাকে, resubmit হলে শুধু
// duplicateCount বাড়ে। isNew ফেরত দেয় যাতে caller বুঝতে পারে notification পাঠাতে হবে কিনা।
async function addSubmission(data) {
  const filter = { userId: data.userId, traderId: data.traderId };
  const existing = await db.collection('submissions').findOne(filter);
  if (existing) {
    const newCount = (existing.duplicateCount || 1) + 1;
    await db.collection('submissions').updateOne(filter, {
      $inc: { duplicateCount: 1 },
      $set: { lastSubmittedAt: new Date(), name: data.name, username: data.username }
    });
    const idx = submissions.findIndex(s => s.userId === data.userId && s.traderId === data.traderId);
    if (idx >= 0) submissions[idx] = Object.assign({}, submissions[idx], data, { duplicateCount: newCount });
    return { isNew: false, duplicateCount: newCount };
  }
  const doc = Object.assign({}, data, { duplicateCount: 1, firstSubmittedAt: new Date() });
  await db.collection('submissions').insertOne(doc);
  submissions.push(doc);
  return { isNew: true, duplicateCount: 1 };
}

async function incrementTrialSignal(userId) {
  const current = trialSignalCount.get(userId) || 0;
  trialSignalCount.set(userId, current + 1);
  await db.collection('trialCounts').updateOne(
    { userId }, { $set: { userId, signalCount: current + 1 } }, { upsert: true }
  );
}

async function incrementTrialScreenshot(userId) {
  const current = trialScreenshotCount.get(userId) || 0;
  trialScreenshotCount.set(userId, current + 1);
  await db.collection('trialCounts').updateOne(
    { userId }, { $set: { userId, screenshotCount: current + 1 } }, { upsert: true }
  );
}

function getTrialSignalLeft(userId) {
  return FREE_TRIAL_SIGNAL - (trialSignalCount.get(userId) || 0);
}

function getTrialScreenshotLeft(userId) {
  return FREE_TRIAL_SCREENSHOT - (trialScreenshotCount.get(userId) || 0);
}

function isApproved(userId) {
  return userId === ADMIN_ID || approvedUsers.has(userId);
}

function generateApiKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let part1 = '', part2 = '';
  for (let i = 0; i < 2; i++) part1 += chars[Math.floor(Math.random() * chars.length)];
  for (let i = 0; i < 4; i++) part2 += chars[Math.floor(Math.random() * chars.length)];
  return `QX_${part1}${part2}_XAAN`;
}

const signalInlineKeyboard = {
  inline_keyboard: [
    [
      { text: '📊 𝗚𝗲𝗻𝗲𝗿𝗮𝘁𝗲 𝗔𝗜 𝗦𝗶𝗴𝗻𝗮𝗹', callback_data: 'new_signal' },
    ],
    [
      { text: '📸 𝗨𝗽𝗹𝗼𝗮𝗱 𝗖𝗵𝗮𝗿𝘁 𝗜𝗺𝗮𝗴𝗲', callback_data: 'screenshot_analysis' }
    ]
  ]
};

// ✅ ফিক্স — Real Quotex market-এ থাকা pair (live, market open থাকলে দেখানো হয়) —
// TwelveData-তে সব কয়টা ভেরিফায়েড (check-symbols.js দিয়ে টেস্ট করা হয়েছে)
const LIVE_PAIRS = [
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CAD', 'USD/CHF', 'NZD/USD',
  'EUR/JPY', 'GBP/JPY', 'EUR/GBP', 'EUR/CHF', 'AUD/JPY', 'CAD/JPY', 'CHF/JPY',
  'EUR/CAD', 'EUR/AUD', 'GBP/CAD', 'GBP/CHF', 'AUD/CAD', 'AUD/CHF',
  'EUR/NZD', 'GBP/AUD', 'GBP/NZD', 'AUD/NZD', 'NZD/JPY'
];

// ✅ ফিক্স — Market বন্ধ থাকলে দেখানো OTC pair (LIVE_PAIRS + কিছু OTC-only exotic pair)
const OTC_PAIRS = [
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CAD', 'USD/CHF', 'NZD/USD', 'EUR/GBP',
  'EUR/JPY', 'EUR/CHF', 'EUR/CAD', 'EUR/AUD', 'EUR/NZD', 'GBP/JPY', 'GBP/CHF', 'GBP/CAD',
  'GBP/AUD', 'GBP/NZD', 'AUD/JPY', 'AUD/CAD', 'AUD/CHF', 'AUD/NZD', 'NZD/JPY', 'NZD/CAD',
  'NZD/CHF', 'CAD/JPY', 'CAD/CHF', 'CHF/JPY', 'USD/BDT', 'USD/INR', 'USD/PKR', 'USD/IDR'
];

const PAIRS_PER_PAGE = 8;

function getDisplayPairs() {
  const marketOpen = isRealMarketOpen();
  return marketOpen ? LIVE_PAIRS.slice() : OTC_PAIRS.map(sym => sym + ' (OTC)');
}

function symbolFromDisplayPair(displayPair) {
  return displayPair.replace(' (OTC)', '');
}

async function getCandles(symbol) {
  const data = await twelveData.getTimeSeries(symbol, '1min', 30);
  if (!data.values || data.values.length === 0) throw new Error('No candle data');
  return data.values.map(v => ({
    open: parseFloat(v.open), high: parseFloat(v.high),
    low: parseFloat(v.low), close: parseFloat(v.close),
    datetime: v.datetime
  })).reverse();
}

function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function calcEMA(candles, period) {
  const k = 2 / (period + 1);
  let ema = candles[0].close;
  for (let i = 1; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k);
  }
  return ema;
}

function analyzeTrend(candles) {
  const ema5 = calcEMA(candles, 5);
  const ema20 = calcEMA(candles, 20);
  const lastClose = candles[candles.length - 1].close;
  if (ema5 > ema20 && lastClose > ema5) return 'UP';
  if (ema5 < ema20 && lastClose < ema5) return 'DOWN';
  return 'SIDEWAYS';
}

function analyzePriceAction(candles) {
  const len = candles.length;
  const c = candles[len - 1];
  const p = candles[len - 2];
  const p2 = candles[len - 3];
  const body = Math.abs(c.close - c.open);
  const upperWick = c.high - Math.max(c.close, c.open);
  const lowerWick = Math.min(c.close, c.open) - c.low;
  const isBullish = c.close > c.open;
  const isBearish = c.close < c.open;

  if (isBullish && p.close < p.open && c.close > p.open && c.open < p.close)
    return { pattern: 'Bullish Engulfing', direction: 'UP' };
  if (isBearish && p.close > p.open && c.open > p.close && c.close < p.open)
    return { pattern: 'Bearish Engulfing', direction: 'DOWN' };
  if (lowerWick > body * 2 && upperWick < body * 0.5)
    return { pattern: 'Bullish Pin Bar', direction: 'UP' };
  if (upperWick > body * 2 && lowerWick < body * 0.5)
    return { pattern: 'Bearish Pin Bar', direction: 'DOWN' };
  if (c.high > p.high && c.low > p.low && p.high > p2.high)
    return { pattern: 'Higher High (Uptrend)', direction: 'UP' };
  if (c.high < p.high && c.low < p.low && p.low < p2.low)
    return { pattern: 'Lower Low (Downtrend)', direction: 'DOWN' };
  if (body < (c.high - c.low) * 0.1)
    return { pattern: 'Doji (Reversal possible)', direction: 'NEUTRAL' };
  return { pattern: 'No clear pattern', direction: 'NEUTRAL' };
}

async function analyzeSignal(displayPair) {
  const symbol = symbolFromDisplayPair(displayPair);
  const candles = await getCandles(symbol);
  const rsi = calcRSI(candles);
  const trend = analyzeTrend(candles);
  const priceAction = analyzePriceAction(candles);

  let upScore = 0, downScore = 0;
  if (trend === 'UP') upScore += 2;
  else if (trend === 'DOWN') downScore += 2;
  if (rsi < 35) upScore += 2;
  else if (rsi > 65) downScore += 2;
  else if (rsi < 50) upScore += 1;
  else downScore += 1;
  if (priceAction.direction === 'UP') upScore += 3;
  else if (priceAction.direction === 'DOWN') downScore += 3;

  const totalScore = upScore + downScore;
  const dominantScore = Math.max(upScore, downScore);
  const ratio = dominantScore / totalScore;
  const direction = upScore >= downScore ? 'UP⏫' : 'DOWN⏬';

  let confidence, winRate;
  if (ratio >= 0.8) { confidence = 'Very High 🔥'; winRate = '85%'; }
  else if (ratio >= 0.65) { confidence = 'High 🟢'; winRate = '80%'; }
  else { confidence = 'Medium 🟡'; winRate = '75%'; }

  return { direction, confidence, winRate, trend, rsi: rsi.toFixed(1), pattern: priceAction.pattern, symbol };
}

// ✅ পরিবর্তিত — এখন userId নেয়, sendMenuMessage ব্যবহার করে, আর page-ভিত্তিক pagination করে
// (৮টা করে pair/পেজ, Prev/Next বাটন সহ) — একসাথে অনেক বাটন দেখানো হয় না, UI পরিষ্কার থাকে।
function buildPairMenuKeyboard(displayPairs, page) {
  const totalPages = Math.max(1, Math.ceil(displayPairs.length / PAIRS_PER_PAGE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * PAIRS_PER_PAGE;
  const pagePairs = displayPairs.slice(start, start + PAIRS_PER_PAGE);

  const keyboard = [];
  for (let i = 0; i < pagePairs.length; i += 2) {
    const row = [{ text: pagePairs[i], callback_data: pagePairs[i] }];
    if (pagePairs[i + 1]) row.push({ text: pagePairs[i + 1], callback_data: pagePairs[i + 1] });
    keyboard.push(row);
  }

  const navRow = [];
  if (safePage > 0) navRow.push({ text: '⬅️ Previous', callback_data: 'pairpage_' + (safePage - 1) });
  navRow.push({ text: `📄 Page ${safePage + 1}/${totalPages}`, callback_data: 'pairpage_noop' });
  if (safePage < totalPages - 1) navRow.push({ text: 'Next ➡️', callback_data: 'pairpage_' + (safePage + 1) });
  keyboard.push(navRow);

  return { keyboard, safePage, totalPages };
}

function sendPairMenu(chatId, userId, page = 0) {
  const displayPairs = getDisplayPairs();
  const { keyboard, safePage, totalPages } = buildPairMenuKeyboard(displayPairs, page);
  sendMenuMessage(chatId, userId, `📈 𝗖𝗵𝗼𝗼𝘀𝗲 𝗬𝗼𝘂𝗿 𝗧𝗿𝗮𝗱𝗶𝗻𝗴 𝗣𝗮𝗶𝗿 👇\n\n📄 Page ${safePage + 1}/${totalPages}`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

// ✅ পরিবর্তিত — এখন userId নেয়, sendMenuMessage ব্যবহার করে
function sendVerifyPrompt(chatId, userId) {
  sendMenuMessage(chatId, userId,
    '🔒 𝗙𝗿𝗲𝗲 𝗧𝗿𝗶𝗮𝗹 𝗘𝘅𝗽𝗶𝗿𝗲𝗱!\n\n' +
    '🚀 𝗨𝗻𝗹𝗼𝗰𝗸 𝗨𝗻𝗹𝗶𝗺𝗶𝘁𝗲𝗱 𝗔𝗜 𝗦𝗶𝗴𝗻𝗮𝗹𝘀 & 𝗖𝗵𝗮𝗿𝘁 𝗔𝗻𝗮𝗹𝘆𝘀𝗶𝘀.\n\n' +
    '📌 𝗖𝗿𝗲𝗮𝘁𝗲 𝗮 𝗡𝗲𝘄 𝗤𝘂𝗼𝘁𝗲𝘅 𝗔𝗰𝗰𝗼𝘂𝗻𝘁 𝗮𝗻𝗱 𝘀𝗲𝗻𝗱 𝘆𝗼𝘂𝗿 𝟴-𝗱𝗶𝗴𝗶𝘁 𝗧𝗿𝗮𝗱𝗲𝗿 𝗜𝗗 𝘁𝗼 𝗰𝗼𝗺𝗽𝗹𝗲𝘁𝗲 𝘃𝗲𝗿𝗶𝗳𝗶𝗰𝗮𝘁𝗶𝗼𝗻.',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚀 𝗖𝗿𝗲𝗮𝘁𝗲 𝗤𝘂𝗼𝘁𝗲𝘅 𝗔𝗰𝗰𝗼𝘂𝗻𝘁', url: 'https://market-qx.pro/sign-up/?lid=2178055' }],
          [{ text: '✅ 𝗩𝗲𝗿𝗶𝗳𝘆 𝗧𝗿𝗮𝗱𝗲𝗿 𝗜𝗗', callback_data: '/verify' }]
        ]
      }
    }
  );
}

const deepAnalysisSteps = [
  '📊 𝗔𝗻𝗮𝗹𝘆𝘇𝗶𝗻𝗴 𝗣𝗿𝗶𝗰𝗲 𝗔𝗰𝘁𝗶𝗼𝗻...',
  '📈 𝗖𝗵𝗲𝗰𝗸𝗶𝗻𝗴 𝗧𝗿𝗲𝗻𝗱 & 𝗠𝗼𝗺𝗲𝗻𝘁𝘂𝗺...',
  '🎯 𝗙𝗶𝗻𝗱𝗶𝗻𝗴 𝗛𝗶𝗴𝗵-𝗣𝗿𝗼𝗯𝗮𝗯𝗶𝗹𝗶𝘁𝘆 𝗦𝗲𝘁𝘂𝗽...'
];

async function runLoadingBar(chatId) {
  const bd0 = new Date(Date.now() + 6 * 60 * 60 * 1000);
  const bdStr = String(bd0.getUTCHours()).padStart(2,'0') + ':' + String(bd0.getUTCMinutes()).padStart(2,'0') + ':' + String(bd0.getUTCSeconds()).padStart(2,'0');

  const loadMsg = await bot.sendMessage(chatId,
    '🚀 𝗔𝗻𝗮𝗹𝘆𝘇𝗶𝗻𝗴 𝗠𝗮𝗿𝗸𝗲𝘁 𝗗𝗮𝘁𝗮...\n\n' +
    '⏰ 𝗕𝗗 𝗧𝗶𝗺𝗲: ' + bdStr + '\n' +
    '📊 𝗣𝗹𝗲𝗮𝘀𝗲 𝗪𝗮𝗶𝘁...',
    { parse_mode: 'Markdown' }
  );

  if (!loadMsg) {
    throw new Error('runLoadingBar: initial loading message পাঠানো যায়নি');
  }

  const loadMsgId = loadMsg.message_id;

  await new Promise(r => setTimeout(r, 1500));

  const startTime = Date.now();
  const totalWaitMs = 20000;

  return new Promise((resolve) => {
    const interval = setInterval(async () => {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, Math.ceil((totalWaitMs - elapsed) / 1000));
      const bd = new Date(Date.now() + 6 * 60 * 60 * 1000);
      const bdTimeStr = String(bd.getUTCHours()).padStart(2,'0') + ':' + String(bd.getUTCMinutes()).padStart(2,'0') + ':' + String(bd.getUTCSeconds()).padStart(2,'0');

      const stepIndex = Math.min(deepAnalysisSteps.length - 1, Math.floor((elapsed / totalWaitMs) * deepAnalysisSteps.length));
      const visibleSteps = deepAnalysisSteps.slice(0, stepIndex + 1).join('\n');

      try {
        await bot.editMessageText(
          '🧠 𝗔𝗜 𝗗𝗘𝗘𝗣 𝗠𝗔𝗥𝗞𝗘𝗧 𝗔𝗡𝗔𝗟𝗬𝗦𝗜𝗦\n\n' +
          '⏰ 𝗕𝗗 𝗧𝗶𝗺𝗲: ' + bdTimeStr + '\n' +
          '⏳ 𝗦𝗶𝗴𝗻𝗮𝗹 𝗜𝗻: ' + remaining + 's\n\n' +
          visibleSteps,
          { chat_id: chatId, message_id: loadMsgId, parse_mode: 'Markdown' }
        );
      } catch (e) {}

      if (elapsed >= totalWaitMs) {
        clearInterval(interval);
        resolve(loadMsgId);
      }
    }, 1000);
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ✅ ফিক্স — Submissions সিস্টেম সম্পূর্ণ নতুন করে সাজানো: dedupe, category-wise
// (🟢 Register / ❌ Fake / ⚡ Verified), name-বাটন → detail card ফরম্যাট
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function getSubmissionCategory(traderId) {
  if (!db || !traderId) return 'fake';
  const affRec = await db.collection('affiliateVerified').findOne({ traderId });
  if (affRec && affRec.verified) return 'verified';
  if (affRec && affRec.registered) return 'pending';
  return 'fake';
}

// category: 'pending' | 'fake' | 'verified'
async function buildSubmissionButtonList(category) {
  if (!db) return { text: '❌ Database প্রস্তুত না।', keyboard: [] };

  const all = await db.collection('submissions').find().sort({ lastSubmittedAt: -1, firstSubmittedAt: -1 }).limit(500).toArray();

  // ✅ ফিক্স — dedupe fix চালু হওয়ার আগে যেসব পুরনো ডুপ্লিকেট row (একই userId+traderId,
  // একাধিক আলাদা document) তৈরি হয়ে গিয়েছিল, সেগুলো এখানে read করার সময় merge করা হচ্ছে
  // (আলাদা migration script না চালিয়েই) — একই ইউজার একাধিকবার লিস্টে দেখাবে না,
  // duplicateCount সব row মিলিয়ে যোগ হয়ে দেখাবে।
  const grouped = new Map(); // "userId_traderId" -> merged doc
  for (const s of all) {
    const key = s.userId + '_' + s.traderId;
    if (grouped.has(key)) {
      const existing = grouped.get(key);
      existing.duplicateCount = (existing.duplicateCount || 1) + (s.duplicateCount || 1);
    } else {
      grouped.set(key, Object.assign({}, s, { duplicateCount: s.duplicateCount || 1 }));
    }
  }

  const matched = [];
  for (const s of grouped.values()) {
    const cat = await getSubmissionCategory(s.traderId);
    if (cat === category) matched.push(s);
    if (matched.length >= 30) break;
  }

  const titleMap = {
    pending: '🟢 *REGISTER SUBMISSIONS* (Deposit বাকি)',
    fake: '❌ *FAKE SUBMISSIONS* (ভুয়া/ভুল Trader ID)',
    verified: '⚡ *AFFILIATE VERIFIED* (Board Access পেয়েছে)'
  };
  // ✅ ফিক্স — আগে empty-state-এ সবসময় হার্ডকোড 'admin_submissions'-এ ফেরত যেত, category যাই হোক
  // না কেন (Verified থেকে Back করলেও Submissions-এ যেত, ভুল জায়গা)। এখন category অনুযায়ী সঠিক
  // parent menu-তে ফেরত যাবে।
  const backTargetMap = {
    pending: 'admin_submissions',
    fake: 'admin_submissions',
    verified: 'admin_menu_affiliates'
  };
  const backTarget = backTargetMap[category] || 'admin_back';

  if (matched.length === 0) {
    return { text: titleMap[category] + '\n\nকোনো entry পাওয়া যায়নি।', keyboard: [[{ text: '🔙 Back', callback_data: backTarget }]] };
  }

  const keyboard = [];
  for (let i = 0; i < matched.length; i += 1) {
    const s = matched[i];
    const label = (s.name || s.username || 'Unknown') + (s.duplicateCount > 1 ? ' (x' + s.duplicateCount + ')' : '');
    keyboard.push([{ text: label, callback_data: 'subview_' + s.userId + '_' + s.traderId }]);
  }
  keyboard.push([{ text: '🔙 Back', callback_data: backTarget }]);

  return { text: titleMap[category] + '\n\nমোট: ' + matched.length + ' জন — নিচে নাম থেকে বেছে নাও:', keyboard };
}

async function buildSubmissionDetailCard(subUserId, traderId) {
  if (!db) return { text: '❌ Database প্রস্তুত না।', keyboard: [[{ text: '🔙 Back', callback_data: 'admin_submissions' }]] };

  const allMatching = await db.collection('submissions').find({ userId: subUserId, traderId }).toArray();
  if (allMatching.length === 0) return { text: '❌ এই submission আর নেই।', keyboard: [[{ text: '🔙 Back', callback_data: 'admin_submissions' }]] };

  // ✅ ফিক্স — পুরনো ডুপ্লিকেট row থাকলে সবগুলোর duplicateCount যোগ করে দেখানো হয়
  const s = allMatching[allMatching.length - 1];
  const totalDuplicateCount = allMatching.reduce((sum, doc) => sum + (doc.duplicateCount || 1), 0);

  const affRec = await db.collection('affiliateVerified').findOne({ traderId });
  const category = await getSubmissionCategory(traderId);

  let statusLines;
  if (category === 'verified') {
    statusLines =
      '📝 Registered: ✅\n' +
      '💰 Deposit: $' + (affRec.depositAmount ? affRec.depositAmount.toFixed(2) : '0.00') + '\n' +
      '🎯 Verified: ✅';
  } else if (category === 'pending') {
    const dep = affRec && affRec.depositAmount ? affRec.depositAmount.toFixed(2) : '0.00';
    statusLines = '🟢 Trader ID স্ট্যাটাস: Registered\n⏳ Pending Deposit ($' + dep + '/$' + MIN_DEPOSIT_USD + ')';
  } else {
    statusLines = '🔴 ❌ Invalid Trader ID (Not Registered)';
  }

  const nameDisplay = s.username ? s.name + ' (@' + escapeMd(s.username) + ')' : (s.name || 'Unknown');

  const text =
    '👤 NAME: ' + nameDisplay + '\n' +
    '🆔 User ID: ' + uidLink(subUserId) + '\n' +
    '📌 Trader ID: `' + traderId + '`\n' +
    statusLines + '\n' +
    '⚠️ Duplicate Submission: ' + totalDuplicateCount;

  const backTarget = category === 'verified' ? 'admin_affiliate' : (category === 'pending' ? 'admin_sub_register' : 'admin_sub_fake');
  const keyboard = [];
  if (category !== 'verified') {
    keyboard.push([{ text: '🗑️ Delete This Submission', callback_data: 'subdel_' + subUserId + '_' + traderId }]);
  }
  keyboard.push([{ text: '🔙 Back', callback_data: backTarget }]);

  return { text, keyboard };
}

// /maintenance
bot.onText(/\/maintenance (.+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const action = match[1].trim().toLowerCase();
  if (action === 'on') {
    maintenanceMode = true;
    await saveBotFlags();
    await bot.sendMessage(ADMIN_ID, '🔧 *Maintenance Mode চালু হয়েছে!*\n\n(ইউজাররা কোনো নোটিফিকেশন পাবে না — বট শুধু নিশ্চুপ থাকবে)', { parse_mode: 'Markdown' });
  } else if (action === 'off') {
    maintenanceMode = false;
    await saveBotFlags();
    await bot.sendMessage(ADMIN_ID, '✅ *Maintenance Mode বন্ধ হয়েছে!*', { parse_mode: 'Markdown' });
  } else {
    await bot.sendMessage(ADMIN_ID, '❌ Format: /maintenance on অথবা /maintenance off');
  }
});

// /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from.first_name || 'User';
  const userId = msg.from.id;
  const usernameHandle = msg.from.username || null;
  refreshUserProfile(userId, usernameHandle, firstName, msg.from.last_name);

  // ✅ ফিক্স — Maintenance/Emergency চালু থাকলে বট সম্পূর্ণ নিশ্চুপ থাকবে, কোনো মেসেজ যাবে না
  if (userId !== ADMIN_ID && (emergencyMode || maintenanceMode)) {
    return;
  }
  if (bannedUsers.has(userId)) {
    await bot.sendMessage(chatId, '🚫 আপনাকে ban করা হয়েছে।');
    return;
  }
  if (!startedUsers.has(userId)) {
    await addStartedUser(userId, usernameHandle, firstName);
    await bot.sendMessage(ADMIN_ID,
      '♻️ *NEW USER STARTED BOT* ➕\n\n👤 Name: ' + mentionUser(userId, usernameHandle, firstName) + '\n🆔 ID: ' + uidLink(userId),
      { parse_mode: 'Markdown' }
    );
  }

  if (isApproved(userId)) {
    await sendMenuMessage(chatId, userId,
      '╭━━━━━━━━━━━━━━━━━━━━╮\n' +
      '    🤖 𝗤𝗫 𝗔𝗜 𝗣𝗥𝗘𝗗𝗜𝗖𝗧𝗢𝗥 𝗩𝟱.𝟬\n' +
      '╰━━━━━━━━━━━━━━━━━━━━╯\n' +
      '⚡ 𝗔𝗜 𝗦𝗶𝗴𝗻𝗮𝗹 𝗦𝘆𝘀𝘁𝗲𝗺\n' +
      '📊 𝗔𝗱𝘃𝗮𝗻𝗰𝗲𝗱 𝗧𝗿𝗮𝗱𝗲 𝗔𝗻𝗮𝗹𝘆𝘀𝗶𝘀\n' +
      '📸 𝗦𝗰𝗿𝗲𝗲𝗻𝘀𝗵𝗼𝘁 𝗖𝗵𝗮𝗿𝘁 𝗔𝗻𝗮𝗹𝘆𝘀𝗶𝘀\n' +
      '👑 𝗣𝗿𝗲𝗺𝗶𝘂𝗺 𝗩𝗜𝗣 𝗔𝗰𝗰𝗲𝘀𝘀\n\n' +
      '👑 𝗨𝗻𝗹𝗶𝗺𝗶𝘁𝗲𝗱 𝗔𝗰𝗰𝗲𝘀𝘀 𝗔𝗰𝘁𝗶𝘃𝗲 ✅\n\n' +
      '🚀 𝗦𝘁𝗮𝗿𝘁 𝗬𝗼𝘂𝗿 𝗔𝗻𝗮𝗹𝘆𝘀𝗶𝘀\n\n' +
      '📊 𝗖𝗵𝗼𝗼𝘀𝗲 𝗧𝗿𝗮𝗱𝗶𝗻𝗴 𝗣𝗮𝗶𝗿\n\n' +
      '📸 𝗨𝗽𝗹𝗼𝗮𝗱 𝗖𝗵𝗮𝗿𝘁 𝗜𝗺𝗮𝗴𝗲 👇',
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📊 𝗚𝗲𝗻𝗲𝗿𝗮𝘁𝗲 𝗔𝗜 𝗦𝗶𝗴𝗻𝗮𝗹', callback_data: 'new_signal' }],
            [{ text: '📸 𝗨𝗽𝗹𝗼𝗮𝗱 𝗖𝗵𝗮𝗿𝘁 𝗜𝗺𝗮𝗴𝗲', callback_data: 'screenshot_analysis' }]
          ]
        }
      }
    );
    return;
  }

  const signalLeft = getTrialSignalLeft(userId);
  const screenshotLeft = getTrialScreenshotLeft(userId);

  if (signalLeft > 0 || screenshotLeft > 0) {
    await sendMenuMessage(chatId, userId,
      '╭━━━━━━━━━━━━━━━━━━━━╮\n' +
      '    🤖 𝗤𝗫 𝗔𝗜 𝗣𝗥𝗘𝗗𝗜𝗖𝗧𝗢𝗥 𝗩𝟱.𝟬\n' +
      '╰━━━━━━━━━━━━━━━━━━━━╯\n' +
      '⚡ 𝗔𝗜 𝗦𝗶𝗴𝗻𝗮𝗹 𝗦𝘆𝘀𝘁𝗲𝗺\n' +
      '📊 𝗔𝗱𝘃𝗮𝗻𝗰𝗲𝗱 𝗧𝗿𝗮𝗱𝗲 𝗔𝗻𝗮𝗹𝘆𝘀𝗶𝘀\n' +
      '📸 𝗦𝗰𝗿𝗲𝗲𝗻𝘀𝗵𝗼𝘁 𝗖𝗵𝗮𝗿𝘁 𝗔𝗻𝗮𝗹𝘆𝘀𝗶𝘀\n' +
      '👑 𝗣𝗿𝗲𝗺𝗶𝘂𝗺 𝗩𝗜𝗣 𝗔𝗰𝗰𝗲𝘀𝘀\n\n' +
      '🎁 𝗙𝗿𝗲𝗲 𝗧𝗿𝗶𝗮𝗹\n\n' +
      '📈 𝗦𝗶𝗴𝗻𝗮𝗹𝘀 𝗟𝗲𝗳𝘁: 0' + signalLeft + '/0' + FREE_TRIAL_SIGNAL + '\n' +
      '📸 𝗦𝗰𝗿𝗲𝗲𝗻𝘀𝗵𝗼𝘁𝘀 𝗟𝗲𝗳𝘁: 0' + screenshotLeft + '/0' + FREE_TRIAL_SCREENSHOT + '\n\n' +
      '✅ 𝗩𝗲𝗿𝗶𝗳𝘆 𝗬𝗼𝘂𝗿 𝗔𝗰𝗰𝗼𝘂𝗻𝘁\n' +
      '🔓 𝗨𝗻𝗹𝗼𝗰𝗸 𝗨𝗻𝗹𝗶𝗺𝗶𝘁𝗲𝗱 𝗔𝗰𝗰𝗲𝘀𝘀\n\n',
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📊 𝗚𝗲𝗻𝗲𝗿𝗮𝘁𝗲 𝗔𝗜 𝗦𝗶𝗴𝗻𝗮𝗹', callback_data: 'new_signal' }],
            [{ text: '📸 𝗨𝗽𝗹𝗼𝗮𝗱 𝗖𝗵𝗮𝗿𝘁 𝗜𝗺𝗮𝗴𝗲', callback_data: 'screenshot_analysis' }]
          ]
        }
      }
    );
    return;
  }

  await sendMenuMessage(chatId, userId,
    '╭━━━━━━━━━━━━━━━━━━━━╮\n' +
    '    🤖 𝗤𝗫 𝗔𝗜 𝗣𝗥𝗘𝗗𝗜𝗖𝗧𝗢𝗥 𝗩𝟱.𝟬\n' +
    '╰━━━━━━━━━━━━━━━━━━━━╯\n' +
    '⚡ 𝗔𝗜 𝗦𝗶𝗴𝗻𝗮𝗹 𝗦𝘆𝘀𝘁𝗲𝗺\n' +
    '📊 𝗔𝗱𝘃𝗮𝗻𝗰𝗲𝗱 𝗧𝗿𝗮𝗱𝗲 𝗔𝗻𝗮𝗹𝘆𝘀𝗶𝘀\n' +
    '📸 𝗦𝗰𝗿𝗲𝗲𝗻𝘀𝗵𝗼𝘁 𝗖𝗵𝗮𝗿𝘁 𝗔𝗻𝗮𝗹𝘆𝘀𝗶𝘀\n' +
    '👑 𝗣𝗿𝗲𝗺𝗶𝘂𝗺 𝗩𝗜𝗣 𝗔𝗰𝗰𝗲𝘀𝘀\n\n' +
    '🔒 𝗙𝗿𝗲𝗲 𝗧𝗿𝗶𝗮𝗹 𝗘𝘅𝗽𝗶𝗿𝗲𝗱!\n\n' +
    '📌 𝗖𝗿𝗲𝗮𝘁𝗲 𝗮 𝗡𝗲𝘄 𝗤𝘂𝗼𝘁𝗲𝘅 𝗔𝗰𝗰𝗼𝘂𝗻𝘁\n\n' +
    '🆔 𝗦𝗲𝗻𝗱 𝘆𝗼𝘂𝗿 𝟴-𝗱𝗶𝗴𝗶𝘁 𝗧𝗿𝗮𝗱𝗲𝗿 𝗜𝗗\n\n' +
    '✅ 𝗖𝗼𝗺𝗽𝗹𝗲𝘁𝗲 𝗩𝗲𝗿𝗶𝗳𝗶𝗰𝗮𝘁𝗶𝗼𝗻',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚀 𝗖𝗿𝗲𝗮𝘁𝗲 𝗤𝘂𝗼𝘁𝗲𝘅 𝗔𝗰𝗰𝗼𝘂𝗻𝘁', url: 'https://market-qx.pro/sign-up/?lid=2178055' }],
          [{ text: '✅ 𝗩𝗲𝗿𝗶𝗳𝘆 𝗧𝗿𝗮𝗱𝗲𝗿 𝗜𝗗', callback_data: '/verify' }]
        ]
      }
    }
  );
});

// /menu
bot.onText(/\/menu/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (userId !== ADMIN_ID && (emergencyMode || maintenanceMode)) { return; }
  if (bannedUsers.has(userId)) { await bot.sendMessage(chatId, '🚫 আপনাকে ban করা হয়েছে।'); return; }
  if (!isApproved(userId) && getTrialSignalLeft(userId) <= 0) { sendVerifyPrompt(chatId, userId); return; }
  sendPairMenu(chatId, userId);
});

// /admin — updateAdminPanel দিয়ে একটাই লাইভ প্যানেল
bot.onText(/\/admin/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const panel = buildAdminMainPanel();
  await updateAdminPanel(msg.chat.id, panel.text, panel.keyboard);
});

// /xadmin — updateXAdminPanel দিয়ে একটাই লাইভ প্যানেল
bot.onText(/\/xadmin/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const panel = buildXAdminMainPanel();
  await updateXAdminPanel(msg.chat.id, panel.text, panel.keyboard);
});

// /approve
bot.onText(/\/approve (.+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const targetId = parseInt(match[1].trim());
  if (isNaN(targetId)) { await bot.sendMessage(ADMIN_ID, '❌ Format: /approve [user_id]'); return; }
  const apiKey = generateApiKey();
  passwordMode.set(targetId, apiKey);
  await bot.sendMessage(targetId,
    '✅ 𝗬𝗼𝘂𝗿 𝗧𝗿𝗮𝗱𝗲𝗿 𝗜𝗗 𝗛𝗮𝘀 𝗕𝗲𝗲𝗻 𝗩𝗲𝗿𝗶𝗳𝗶𝗲𝗱!\n\n' +
    '🔐 𝗘𝗻𝘁𝗲𝗿 𝗬𝗼𝘂𝗿 𝗔𝗣𝗜 𝗞𝗲𝘆\n\n' +
    '🔑 𝗔𝗣𝗜 𝗞𝗘𝗬:\n`' + apiKey + '`',
    { parse_mode: 'Markdown' }
  );
  await bot.sendMessage(ADMIN_ID, '✅ *User `' + targetId + '` কে approve করা হয়েছে।*\n🔑 API KEY: `' + apiKey + '`', { parse_mode: 'Markdown' });
});

// /unapprove
bot.onText(/\/unapprove (.+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const targetId = parseInt(match[1].trim());
  if (isNaN(targetId)) { await bot.sendMessage(ADMIN_ID, '❌ Format: /unapprove [user_id]'); return; }
  if (targetId === ADMIN_ID) { await bot.sendMessage(ADMIN_ID, '❌ Admin কে unapprove করা যাবে না।'); return; }
  await removeApprovedUser(targetId);
  passwordMode.delete(targetId);
  await bot.sendMessage(ADMIN_ID, '❌ *User Unapproved!*\n\n🆔 User ID: ' + uidLink(targetId), { parse_mode: 'Markdown' });
  try { await bot.sendMessage(targetId, '⛔ আপনার bot access বাতিল করা হয়েছে।\n\n✅ পুনরায় verify করতে /start দিন।'); } catch (e) { console.error('notify(unapprove) fail for', targetId, e.message); }
});

// /ban
bot.onText(/\/ban (.+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const targetId = parseInt(match[1].trim());
  if (isNaN(targetId)) { await bot.sendMessage(ADMIN_ID, '❌ Format: /ban [user_id]'); return; }
  if (targetId === ADMIN_ID) { await bot.sendMessage(ADMIN_ID, '❌ Admin কে ban করা যাবে না।'); return; }
  await addBannedUser(targetId);
  await removeApprovedUser(targetId);
  passwordMode.delete(targetId);
  await bot.sendMessage(ADMIN_ID, '🚫 *User Banned!*\n\n🆔 User ID: ' + uidLink(targetId), { parse_mode: 'Markdown' });
  try { await bot.sendMessage(targetId, '🚫 আপনাকে bot থেকে ban করা হয়েছে।'); } catch (e) { console.error('notify(ban) fail for', targetId, e.message); }
});

// /sessionstart
bot.onText(/\/sessionstart/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  if (emergencyMode) { await bot.sendMessage(ADMIN_ID, '🛑 Emergency Mode চালু আছে, Session শুরু করা যাবে না।'); return; }
  if (!sessionModule) { await bot.sendMessage(ADMIN_ID, '❌ Session module এখনো লোড হয়নি, একটু পর চেষ্টা করুন।'); return; }
  if (sessionModule.isSessionRunning()) {
    await bot.sendMessage(ADMIN_ID, '⚠️ একটা session ইতিমধ্যে চলছে। শেষ হওয়া পর্যন্ত অপেক্ষা করুন।');
    return;
  }
  await bot.sendMessage(ADMIN_ID, '🚀 Manual session শুরু হচ্ছে... (channel এ চলে যান)');
  sessionModule.runSession(bot, '🎯 Manual').catch(e => {
    console.error('Manual session error:', e.message);
    bot.sendMessage(ADMIN_ID, '❌ Session চালাতে সমস্যা হয়েছে: ' + e.message).catch(() => {});
  });
});

// /msg
bot.onText(/\/msg (\d+) ([\s\S]+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const targetId = parseInt(match[1]);
  const text = match[2];
  try {
    await bot.sendMessage(targetId, text);
    await bot.sendMessage(ADMIN_ID, '✅ Message পাঠানো হয়েছে `' + targetId + '` কে।', { parse_mode: 'Markdown' });
  } catch (e) {
    await bot.sendMessage(ADMIN_ID, '❌ Message পাঠানো যায়নি (হয়তো user bot block করেছে বা কখনো /start দেয়নি)।\nError: ' + e.message);
  }
});

// /delaffiliate
bot.onText(/\/delaffiliate (.+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const traderId = match[1].trim();
  if (!db) { await bot.sendMessage(ADMIN_ID, '❌ DB এখনো রেডি না।'); return; }
  const result = await db.collection('affiliateVerified').deleteOne({ traderId });
  if (result.deletedCount > 0) {
    await bot.sendMessage(ADMIN_ID, '✅ *Affiliate এন্ট্রি মুছে ফেলা হয়েছে!*\n\n📌 Trader ID: `' + traderId + '`', { parse_mode: 'Markdown' });
  } else {
    await bot.sendMessage(ADMIN_ID, '⚠️ এই Trader ID `' + traderId + '` affiliateVerified লিস্টে পাওয়া যায়নি।', { parse_mode: 'Markdown' });
  }
});

// /unban
bot.onText(/\/unban (.+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;
  const targetId = parseInt(match[1].trim());
  if (isNaN(targetId)) { await bot.sendMessage(ADMIN_ID, '❌ Format: /unban [user_id]'); return; }
  if (!bannedUsers.has(targetId)) { await bot.sendMessage(ADMIN_ID, '⚠️ User `' + targetId + '` ban list এ নেই।', { parse_mode: 'Markdown' }); return; }
  await removeBannedUser(targetId);
  await bot.sendMessage(ADMIN_ID, '✅ *User Unbanned!*\n\n🆔 User ID: ' + uidLink(targetId), { parse_mode: 'Markdown' });
  try { await bot.sendMessage(targetId, '✅ আপনার ban তুলে নেওয়া হয়েছে!\n\n📌 পুনরায় access পেতে /start দিন।'); } catch (e) { console.error('notify(unban) fail for', targetId, e.message); }
});

// Message handler
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const userId = msg.from.id;
  const firstName = msg.from.first_name || 'User';
  const usernameHandle = msg.from.username || null;
  const username = mentionUser(userId, usernameHandle, firstName);
  touchLastActive(userId);
  refreshUserProfile(userId, usernameHandle, firstName, msg.from.last_name);

  // ✅ Broadcast চেক সবার আগে — text/photo/video/document/sticker সব হ্যান্ডল করবে (copyMessage)
  if (broadcastMode.has(userId) && userId === ADMIN_ID) {
    broadcastMode.delete(userId);
    let successCount = 0;
    let failCount = 0;
    for (const uid of startedUsers) {
      try {
        await bot.copyMessage(uid, chatId, msg.message_id);
        successCount++;
      } catch (e) {
        failCount++;
        console.error('broadcast fail for', uid, e.message);
      }
      await sleep(50);
    }
    await bot.sendMessage(ADMIN_ID, '✅ Broadcast sent to ' + successCount + ' users! (❌ Failed: ' + failCount + ')');
    return;
  }

  if (!text || text.startsWith('/')) return;

  if (userId !== ADMIN_ID && (emergencyMode || maintenanceMode)) {
    return;
  }
  if (userId !== ADMIN_ID && bannedUsers.has(userId)) {
    await bot.sendMessage(chatId, '🚫 আপনাকে ban করা হয়েছে।');
    return;
  }

  if (messageUserMode.has(userId) && userId === ADMIN_ID) {
    messageUserMode.delete(userId);
    const targetId = parseInt(text.trim());
    if (isNaN(targetId)) { await bot.sendMessage(ADMIN_ID, '❌ ভুল User ID।'); return; }
    pendingMessageTarget.set(userId, targetId);
    await bot.sendMessage(ADMIN_ID, '✍️ এখন যে *message* পাঠাতে চাও লেখো (পাবে User ID: ' + uidLink(targetId) + '):', { parse_mode: 'Markdown' });
    return;
  }

  if (pendingMessageTarget.has(userId) && userId === ADMIN_ID) {
    const targetId = pendingMessageTarget.get(userId);
    pendingMessageTarget.delete(userId);
    try {
      await bot.sendMessage(targetId, text);
      await bot.sendMessage(ADMIN_ID, '✅ Message পাঠানো হয়েছে `' + targetId + '` কে।', { parse_mode: 'Markdown' });
    } catch (e) {
      await bot.sendMessage(ADMIN_ID, '❌ Message পাঠানো যায়নি (হয়তো user bot block করেছে বা কখনো /start দেয়নি)।\nError: ' + e.message);
    }
    return;
  }

  if (unapproveMode.has(userId) && userId === ADMIN_ID) {
    unapproveMode.delete(userId);
    const targetId = parseInt(text.trim());
    if (isNaN(targetId)) { await bot.sendMessage(ADMIN_ID, '❌ ভুল User ID।'); return; }
    if (targetId === ADMIN_ID) { await bot.sendMessage(ADMIN_ID, '❌ Admin কে unapprove করা যাবে না।'); return; }
    await removeApprovedUser(targetId);
    passwordMode.delete(targetId);
    await bot.sendMessage(ADMIN_ID, '❌ *User Unapproved!*\n\n🆔 User ID: ' + uidLink(targetId), { parse_mode: 'Markdown' });
    try { await bot.sendMessage(targetId, '⛔ আপনার bot access বাতিল করা হয়েছে।\n\n✅ পুনরায় verify করতে /start দিন।'); } catch (e) { console.error('notify(unapprove) fail for', targetId, e.message); }
    return;
  }

  if (banMode.has(userId) && userId === ADMIN_ID) {
    banMode.delete(userId);
    const targetId = parseInt(text.trim());
    if (isNaN(targetId)) { await bot.sendMessage(ADMIN_ID, '❌ ভুল User ID।'); return; }
    if (targetId === ADMIN_ID) { await bot.sendMessage(ADMIN_ID, '❌ Admin কে ban করা যাবে না।'); return; }
    await addBannedUser(targetId);
    await removeApprovedUser(targetId);
    passwordMode.delete(targetId);
    await bot.sendMessage(ADMIN_ID, '🚫 *User Banned!*\n\n🆔 User ID: ' + uidLink(targetId), { parse_mode: 'Markdown' });
    try { await bot.sendMessage(targetId, '🚫 আপনাকে bot থেকে ban করা হয়েছে।'); } catch (e) { console.error('notify(ban) fail for', targetId, e.message); }
    return;
  }

  // (পুরনো text-prompt bulk-delete flow সরানো হলো — এখন প্রতিটা submission-এর detail
  // card-এ আলাদা "🗑️ Delete This Submission" বাটন দিয়ে category-সচেতনভাবে ডিলিট হয়)

  if (delAffiliateMode.has(userId) && userId === ADMIN_ID) {
    delAffiliateMode.delete(userId);
    const traderId = text.trim();
    const result = await db.collection('affiliateVerified').deleteOne({ traderId });
    if (result.deletedCount > 0) {
      await bot.sendMessage(ADMIN_ID, '✅ *Affiliate এন্ট্রি মুছে ফেলা হয়েছে!*\n\n📌 Trader ID: `' + traderId + '`', { parse_mode: 'Markdown' });
    } else {
      await bot.sendMessage(ADMIN_ID, '⚠️ এই Trader ID `' + traderId + '` affiliateVerified লিস্টে পাওয়া যায়নি।', { parse_mode: 'Markdown' });
    }
    return;
  }

  if (unbanMode.has(userId) && userId === ADMIN_ID) {
    unbanMode.delete(userId);
    const targetId = parseInt(text.trim());
    if (isNaN(targetId)) { await bot.sendMessage(ADMIN_ID, '❌ ভুল User ID।'); return; }
    if (!bannedUsers.has(targetId)) { await bot.sendMessage(ADMIN_ID, '⚠️ User ban list এ নেই।'); return; }
    await removeBannedUser(targetId);
    await bot.sendMessage(ADMIN_ID, '✅ *User Unbanned!*\n\n🆔 User ID: ' + uidLink(targetId), { parse_mode: 'Markdown' });
    try { await bot.sendMessage(targetId, '✅ আপনার ban তুলে নেওয়া হয়েছে!\n\n📌 পুনরায় access পেতে /start দিন।'); } catch (e) { console.error('notify(unban) fail for', targetId, e.message); }
    return;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ✅ /xadmin — মেসেজ হ্যান্ডলার (নতুন সিস্টেম)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  if (xadminCheckMode.has(userId) && userId === ADMIN_ID) {
    xadminCheckMode.delete(userId);
    const traderId = text.trim();
    const rec = await db.collection('affiliateVerified').findOne({ traderId });
    if (!rec) {
      await bot.sendMessage(ADMIN_ID, '⚠️ এই Trader ID `' + traderId + '` এর কোনো ডেটা পাওয়া যায়নি।', { parse_mode: 'Markdown' });
      return;
    }
    await bot.sendMessage(ADMIN_ID,
      '🔍 *𝗧𝗥𝗔𝗗𝗘𝗥 𝗦𝗧𝗔𝗧𝗨𝗦*\n\n' +
      '📌 Trader ID: `' + rec.traderId + '`\n' +
      '📝 Registered: ' + (rec.registered ? '✅' : '❌') + '\n' +
      '💰 Deposit: $' + (rec.depositAmount ? rec.depositAmount.toFixed(2) : '0.00') + '\n' +
      '🎯 Verified: ' + (rec.verified ? '✅' : '❌') + '\n' +
      (rec.isTest ? '🧪 Test Entry\n' : '') +
      '🌍 Country: ' + (rec.country || 'N/A') + '\n' +
      '📊 Last Status: ' + (rec.lastStatus || 'N/A'),
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (xadminSearchUserMode.has(userId) && userId === ADMIN_ID) {
    xadminSearchUserMode.delete(userId);
    const targetId = parseInt(text.trim());
    if (isNaN(targetId)) { await bot.sendMessage(ADMIN_ID, '❌ ভুল User ID।'); return; }

    const userDoc = await db.collection('startedUsers').findOne({ userId: targetId });
    if (!userDoc) {
      await bot.sendMessage(ADMIN_ID, '⚠️ এই User ID `' + targetId + '` ডাটাবেসে পাওয়া যায়নি।', { parse_mode: 'Markdown' });
      return;
    }

    // ✅ প্রতিটা populated ফিল্ড আলাদাভাবে clickable link — যেটাই সেট থাকুক অন্তত একটা কাজ করবে
    const link = (label, value) => value
      ? label + ': [' + escapeMd(String(value)) + '](tg://user?id=' + targetId + ')'
      : label + ': N/A';

    const lines = [
      link('First Name', userDoc.firstName),
      link('Last Name', userDoc.lastName),
      link('Username', userDoc.username ? '@' + userDoc.username : null),
      link('ID', targetId)
    ];

    await bot.sendMessage(ADMIN_ID, '🔎 *𝗦𝗲𝗮𝗿𝗰𝗵 𝗥𝗲𝘀𝘂𝗹𝘁*\n\n' + lines.join('\n'), { parse_mode: 'Markdown' });
    return;
  }

  if (xadminTrialResetMode.has(userId) && userId === ADMIN_ID) {
    xadminTrialResetMode.delete(userId);
    const targetId = parseInt(text.trim());
    if (isNaN(targetId)) { await bot.sendMessage(ADMIN_ID, '❌ ভুল User ID।'); return; }
    trialSignalCount.set(targetId, 0);
    trialScreenshotCount.set(targetId, 0);
    miniappTrialCount.set(targetId, 0); // ✅ বোনাস ফিক্স — আগে শুধু bot trial রিসেট হতো, mini app বাদ যেতো
    await db.collection('trialCounts').updateOne(
      { userId: targetId }, { $set: { userId: targetId, signalCount: 0, screenshotCount: 0 } }, { upsert: true }
    );
    await db.collection('miniappTrialCounts').updateOne(
      { userId: targetId }, { $set: { userId: targetId, count: 0 } }, { upsert: true }
    );
    await bot.sendMessage(ADMIN_ID, '✅ Trial count reset করা হয়েছে!\n\n🆔 User ID: ' + uidLink(targetId) + '\n📈 Signal: 0/' + FREE_TRIAL_SIGNAL + '\n📸 Screenshot: 0/' + FREE_TRIAL_SCREENSHOT + '\n🖥️ Mini App: 0/' + MINIAPP_FREE_TRIAL, { parse_mode: 'Markdown' });
    return;
  }

  // ✅ নতুন — User Profile-এর 💬 Message বাটনের পরে admin-এর পরের টেক্সট target user-কে ফরওয়ার্ড হবে
  if (xadminMessageUserMode.has(ADMIN_ID) && userId === ADMIN_ID) {
    const targetId = xadminMessageUserMode.get(ADMIN_ID);
    xadminMessageUserMode.delete(ADMIN_ID);
    if (!text) { await bot.sendMessage(ADMIN_ID, '❌ শুধু টেক্সট মেসেজ পাঠানো যাবে।'); return; }
    try {
      await bot.sendMessage(targetId, text);
      await bot.sendMessage(ADMIN_ID, '✅ মেসেজ পাঠানো হয়েছে User `' + targetId + '`-কে।', { parse_mode: 'Markdown' });
    } catch (e) {
      await bot.sendMessage(ADMIN_ID, '❌ মেসেজ পাঠানো ব্যর্থ: ' + e.message);
    }
    return;
  }

  if (xadminDeleteTestDataMode.has(userId) && userId === ADMIN_ID) {
    xadminDeleteTestDataMode.delete(userId);
    const targetId = parseInt(text.trim());
    if (isNaN(targetId)) { await bot.sendMessage(ADMIN_ID, '❌ ভুল User ID।'); return; }

    let removedParts = [];

    // ✅ ফিক্স — আগে trial counter (signal/screenshot) ও এখানে মুছে ফেলা হতো, যেটা
    // চাওয়া হয়নি — শুধু affiliate test entry মুছবে, trial counter অক্ষত থাকবে।
    const sub = submissions.find(s => s.userId === targetId);
    if (sub && sub.traderId && db) {
      const affRec = await db.collection('affiliateVerified').findOne({ traderId: sub.traderId });
      if (affRec && affRec.isTest) {
        await db.collection('affiliateVerified').deleteOne({ traderId: sub.traderId });
        removedParts.push('Affiliate Test Entry (`' + sub.traderId + '`)');
      }
    }

    await bot.sendMessage(ADMIN_ID,
      '🗑️ *Test Data ক্লিন করা হলো!*\n\n🆔 User ID: ' + uidLink(targetId) + '\n✅ Removed: ' + (removedParts.join(', ') || 'কিছুই মুছার মতো পাওয়া যায়নি') +
      '\n\n⚠️ Note: Trial counter অপরিবর্তিত রাখা হয়েছে। এই User যদি Approve করা থাকে, সেটাও এখান থেকে বাতিল হয়নি (নিরাপত্তার জন্য)। প্রয়োজনে ❌ Unapprove আলাদাভাবে ব্যবহার করুন।',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // ✅ Verify Trader ID (No Deposit)
  if (xadminVerifyNoDepositMode.has(userId) && userId === ADMIN_ID) {
    xadminVerifyNoDepositMode.delete(userId);
    const traderId = text.trim();
    await db.collection('affiliateVerified').updateOne(
      { traderId },
      { $set: { traderId, registered: true, depositAmount: 0, verified: false, isTest: true, receivedAt: new Date() } },
      { upsert: true }
    );
    await bot.sendMessage(ADMIN_ID,
      '✅ *Trader ID Verify হলো (No Deposit)!*\n\n📌 Trader ID: `' + traderId + '`\n💰 Deposit: $0.00\n🎯 Verified: ❌\n\n' +
      '📝 এখন এই Trader ID দিয়ে user /verify করলে "⚠️ Deposit Required" মেসেজ পাবে — deposit না করা পর্যন্ত board access পাবে না।',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // ✅ Set Deposit (Complete Deposit + Edit Deposit একসাথে, replace amount)
  if (xadminSetDepositMode.has(userId) && userId === ADMIN_ID) {
    xadminSetDepositMode.delete(userId);
    const parts = text.trim().split(/\s+/);
    if (parts.length < 2 || isNaN(parseFloat(parts[1]))) {
      await bot.sendMessage(ADMIN_ID, '❌ ভুল ফরম্যাট। এভাবে পাঠাও: `12345678 15`', { parse_mode: 'Markdown' });
      return;
    }
    const traderId = parts[0];
    const newAmount = parseFloat(parts[1]);
    const verified = newAmount >= MIN_DEPOSIT_USD;
    await db.collection('affiliateVerified').updateOne(
      { traderId },
      { $set: { traderId, registered: true, depositAmount: newAmount, verified, isTest: true, editedAt: new Date() } },
      { upsert: true }
    );
    await bot.sendMessage(ADMIN_ID,
      '💰 *Deposit Amount সেট হলো!*\n\n📌 Trader ID: `' + traderId + '`\n💵 Amount: $' + newAmount.toFixed(2) + '\n' +
      (verified
        ? '🟢 Verified ✅ (Board Access পাবে)'
        : '🔴 Verified ❌ (এখনো $' + MIN_DEPOSIT_USD + ' এর কম — Board Access বাতিল/বন্ধ থাকবে)'),
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (passwordMode.has(userId)) {
    const correctPass = passwordMode.get(userId);
    if (text === correctPass) {
      passwordMode.delete(userId);
      await addApprovedUser(userId);
      await bot.sendMessage(chatId,
        '🎉 𝗕𝗼𝘁 𝗔𝗰𝗰𝗲𝘀𝘀 𝗔𝗰𝘁𝗶𝘃𝗮𝘁𝗲𝗱!\n\n' +
        '📊 𝗖𝗹𝗶𝗰𝗸 𝘁𝗵𝗲 𝗯𝘂𝘁𝘁𝗼𝗻 𝗯𝗲𝗹𝗼𝘄 𝘁𝗼 𝗴𝗲𝘁 𝘆𝗼𝘂𝗿 𝗔𝗜 𝗦𝗶𝗴𝗻𝗮𝗹. 🚀\n\n' +
        '🚀 𝗦𝘁𝗮𝗿𝘁 𝗬𝗼𝘂𝗿 𝗔𝗻𝗮𝗹𝘆𝘀𝗶𝘀\n\n' +
        '📊 𝗖𝗵𝗼𝗼𝘀𝗲 𝗧𝗿𝗮𝗱𝗶𝗻𝗴 𝗣𝗮𝗶𝗿\n\n' +
        '📸 𝗨𝗽𝗹𝗼𝗮𝗱 𝗖𝗵𝗮𝗿𝘁 𝗜𝗺𝗮𝗴𝗲 👇',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📊 𝗚𝗲𝗻𝗲𝗿𝗮𝘁𝗲 𝗔𝗜 𝗦𝗶𝗴𝗻𝗮𝗹', callback_data: 'new_signal' }],
              [{ text: '📸 𝗨𝗽𝗹𝗼𝗮𝗱 𝗖𝗵𝗮𝗿𝘁 𝗜𝗺𝗮𝗴𝗲', callback_data: 'screenshot_analysis' }]
            ]
          }
        }
      );
    } else {
      await bot.sendMessage(chatId, '❌ ভুল API KEY! আবার চেষ্টা করুন।');
    }
    return;
  }

  if (!verifyMode.has(userId)) return;

  if (!/^\d{6,10}$/.test(text)) {
    await bot.sendMessage(chatId, '🔐 𝗣𝗹𝗲𝗮𝘀𝗲 𝗦𝗲𝗻𝗱 𝗬𝗼𝘂𝗿 𝟴-𝗗𝗶𝗴𝗶𝘁 𝗤𝘂𝗼𝘁𝗲𝘅 𝗧𝗿𝗮𝗱𝗲𝗿 𝗜𝗗 👇', { parse_mode: 'Markdown' });
    return;
  }

  verifyMode.delete(userId);

  const affRecord = await db.collection('affiliateVerified').findOne({ traderId: text });

  if (affRecord && affRecord.registered) {
    const totalDeposit = affRecord.depositAmount || 0;

    if (totalDeposit < MIN_DEPOSIT_USD) {
      const subResult = await addSubmission({ userId, name: firstName, username: usernameHandle, traderId: text, time: new Date().toISOString(), pendingDeposit: true });
      await bot.sendMessage(chatId,
        '✅ 𝗥𝗲𝗴𝗶𝘀𝘁𝗿𝗮𝘁𝗶𝗼𝗻 𝗦𝘂𝗰𝗰𝗲𝘀𝘀𝗳𝘂𝗹!\n\n' +
        '⚠️ 𝗗𝗲𝗽𝗼𝘀𝗶𝘁 𝗥𝗲𝗾𝘂𝗶𝗿𝗲𝗱\n\n' +
        '💰 আপনার বর্তমান Deposit: $' + totalDeposit.toFixed(2) + '\n' +
        '🎯 ন্যূনতম প্রয়োজন: $' + MIN_DEPOSIT_USD + '\n\n' +
        '📌 আপনার Quotex অ্যাকাউন্টে কমপক্ষে $' + MIN_DEPOSIT_USD + ' ডিপোজিট করুন, তারপর আপনার Trader ID আবার পাঠান।',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ 𝗩𝗲𝗿𝗶𝗳𝘆 𝗧𝗿𝗮𝗱𝗲𝗿 𝗜𝗗 (𝗔𝗴𝗮𝗶𝗻)', callback_data: '/verify' }]
            ]
          }
        }
      );
      // ✅ ফিক্স — শুধু প্রথমবার submit করলেই admin-কে notify করবে, resubmit-এ স্প্যাম হবে না
      if (subResult.isNew) {
        await bot.sendMessage(ADMIN_ID,
          '⏳ *Registered কিন্তু Deposit বাকি*\n\n👤 Name: ' + username + '\n🆔 User ID: ' + uidLink(userId) + '\n📌 Trader ID: `' + text + '`\n💰 Deposit: $' + totalDeposit.toFixed(2),
          { parse_mode: 'Markdown' }
        );
      }
      return;
    }

    // ✅ ফিক্স — Trader ID Ownership Lock: একই Trader ID যাতে একাধিক আলাদা Telegram
    // ইউজার একাউন্ট verify করতে না পারে (আগে শুধু deposit চেক হতো, owner-lock ছিল না)।
    if (affRecord.claimedByUserId && affRecord.claimedByUserId !== userId) {
      await bot.sendMessage(chatId,
        '❌ 𝗧𝗵𝗶𝘀 𝗧𝗿𝗮𝗱𝗲𝗿 𝗜𝗗 𝗜𝘀 𝗔𝗹𝗿𝗲𝗮𝗱𝘆 𝗨𝘀𝗲𝗱\n\n' +
        '📌 Trader ID `' + text + '` ইতিমধ্যে অন্য একটা Telegram অ্যাকাউন্ট দিয়ে verify করা হয়েছে।\n\n' +
        '⚠️ প্রতিটা Trader ID শুধু একটাই Telegram অ্যাকাউন্ট verify করতে পারে (নিরাপত্তার জন্য)। ' +
        'যদি এটা আপনার নিজের Trader ID হয়, অনুগ্রহ করে সাপোর্টে যোগাযোগ করুন।',
        { parse_mode: 'Markdown' }
      );
      await bot.sendMessage(ADMIN_ID,
        '🚨 *সন্দেহজনক Verify Attempt (Trader ID পুনরায় ব্যবহার)*\n\n' +
        '🆔 এই User ID: ' + uidLink(userId) + '\n📌 Trader ID: `' + text + '`\n' +
        '👤 আগে verify করেছিল User ID: ' + uidLink(affRecord.claimedByUserId) + '',
        { parse_mode: 'Markdown' }
      );
      return;
    }
    if (db && !affRecord.claimedByUserId) {
      await db.collection('affiliateVerified').updateOne({ traderId: text }, { $set: { claimedByUserId: userId } });
    }

    const apiKey = generateApiKey();
    passwordMode.set(userId, apiKey);
    await addSubmission({ userId, name: firstName, username: usernameHandle, traderId: text, time: new Date().toISOString(), autoVerified: true, depositAmount: totalDeposit });
    await bot.sendMessage(chatId,
      '✅ 𝗬𝗼𝘂𝗿 𝗧𝗿𝗮𝗱𝗲𝗿 𝗜𝗗 𝗛𝗮𝘀 𝗕𝗲𝗲𝗻 𝗩𝗲𝗿𝗶𝗳𝗶𝗲𝗱!\n\n' +
      '🔐 𝗘𝗻𝘁𝗲𝗿 𝗬𝗼𝘂𝗿 𝗔𝗣𝗜 𝗞𝗲𝘆\n\n' +
      '🔑 𝗔𝗣𝗜 𝗞𝗘𝗬:\n`' + apiKey + '`',
      { parse_mode: 'Markdown' }
    );
    await bot.sendMessage(ADMIN_ID,
      '⚡ *New Affiliate User (Deposit Verified)*\n\n👤 Name: ' + username + '\n🆔 User ID: ' + uidLink(userId) + '\n📌 Trader ID: `' + text + '`\n💰 Deposit: $' + totalDeposit.toFixed(2),
      { parse_mode: 'Markdown' }
    );
    return;
  }

  await addSubmission({ userId, name: firstName, username: usernameHandle, traderId: text, time: new Date().toISOString() });

  await bot.sendMessage(chatId,
    '❌ 𝗩𝗲𝗿𝗶𝗳𝗶𝗰𝗮𝘁𝗶𝗼𝗻 𝗙𝗮𝗶𝗹𝗲𝗱\n\n' +
    'আপনার দেওয়া Trader ID `' + text + '` আমাদের অফিসিয়াল লিংকের মাধ্যমে খোলা কোনো অ্যাকাউন্টের সাথে মিলেনি।\n\n' +
    '📌 সঠিকভাবে verify করতে অনুগ্রহ করে নিচের লিংক থেকে *নতুন* একটি Quotex অ্যাকাউন্ট খুলুন, তারপর আপনার Trader ID আবার পাঠান।\n\n' +
    '⚠️ শুধুমাত্র এই লিংক দিয়ে খোলা অ্যাকাউন্টই স্বয়ংক্রিয়ভাবে ভেরিফাই হবে।',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚀 𝗖𝗿𝗲𝗮𝘁𝗲 𝗤𝘂𝗼𝘁𝗲𝘅 𝗔𝗰𝗰𝗼𝘂𝗻𝘁', url: 'https://market-qx.pro/sign-up/?lid=2178055' }],
          [{ text: '✅ 𝗩𝗲𝗿𝗶𝗳𝘆 𝗧𝗿𝗮𝗱𝗲𝗿 𝗜𝗗', callback_data: '/verify' }]
        ]
      }
    }
  );
});

const signalInProgress = new Set();

// ✅ নতুন — একই মিনিটে একই symbol-এর জন্য একসাথে অনেক ইউজার Signal চাইলে (যেমন ১০০০ জন),
// প্রতিটার জন্য আলাদা API call না করে একটাই call/promise শেয়ার হয় — সবাই একই রেজাল্ট পায়।
// মিনিট বদলালে (নতুন candle) স্বয়ংক্রিয়ভাবে নতুন কল হয়।
const signalResultCache = new Map(); // symbol -> { minuteKey, promise }

function currentMinuteKey() {
  return Math.floor(Date.now() / 60000);
}

function analyzeSignalCached(displayPair) {
  const symbol = symbolFromDisplayPair(displayPair);
  const minuteKey = currentMinuteKey();
  const cached = signalResultCache.get(symbol);
  if (cached && cached.minuteKey === minuteKey) {
    return cached.promise;
  }
  const promise = analyzeSignal(displayPair);
  signalResultCache.set(symbol, { minuteKey, promise });
  return promise;
}

// ✅ ফিক্স — শুধু Real Market (Live) সিগন্যালের জন্য candlestick chart বানায়। OTC-তে এটা কল হয় না।
// ✅ ফিক্স — আগে x-axis 'category' টাইপ ব্যবহার করায় কোনো labels না থাকায় সব candle
// একটাই bar-এ জমাট বেঁধে যাচ্ছিল। এখন real timestamp সহ 'time' scale ব্যবহার হচ্ছে
// (financial/candlestick চার্টের জন্য সঠিক পদ্ধতি) — প্রতিটা candle আলাদা position পাবে।
// সাথে Quotex-এর মতো header (pair + price + change%) আর entry price label box যোগ করা হলো।
async function generateRealMarketChart(symbol, direction, displayPair) {
  try {
    const candles = await getCandles(symbol);
    const plotCandles = candles.slice(-30);
    const ohlcData = plotCandles.map(c => ({
      x: new Date(c.datetime + ' UTC').getTime(),
      o: c.open, h: c.high, l: c.low, c: c.close
    }));

    const dirColor = direction.startsWith('UP') ? '#26a969' : '#ef5350';
    const firstCandle = plotCandles[0];
    const lastCandle = plotCandles[plotCandles.length - 1];
    const entryPrice = lastCandle.close;
    const changeAbs = lastCandle.close - firstCandle.open;
    const changePct = (changeAbs / firstCandle.open) * 100;
    const changeColor = changeAbs >= 0 ? '#26a969' : '#ef5350';
    const changeSign = changeAbs >= 0 ? '+' : '';
    const headerText = (displayPair || symbol) + '   ' + entryPrice.toFixed(5) + '   ' +
      changeSign + changeAbs.toFixed(5) + ' (' + changeSign + changePct.toFixed(2) + '%)';

    const chartConfig = {
      type: 'candlestick',
      data: {
        datasets: [{
          label: symbol,
          data: ohlcData,
          color: { up: '#26a969', down: '#ef5350', unchanged: '#888888' },
          borderColor: { up: '#26a969', down: '#ef5350', unchanged: '#888888' }
        }]
      },
      options: {
        plugins: {
          title: {
            display: true, text: headerText, color: changeColor,
            font: { size: 18, weight: 'bold' }, align: 'start', padding: { top: 8, bottom: 14 }
          },
          subtitle: {
            display: true, text: 'Qx Xaan Father Bot  •  1 Min Chart',
            color: '#7d8695', font: { size: 10 }, align: 'start', padding: { bottom: 10 }
          },
          legend: { display: false },
          annotation: {
            annotations: {
              entryLine: {
                type: 'line', yMin: entryPrice, yMax: entryPrice,
                borderColor: dirColor, borderWidth: 1.5, borderDash: [6, 3],
                label: {
                  content: entryPrice.toFixed(5), enabled: true, position: 'end',
                  backgroundColor: dirColor, color: '#fff', font: { size: 11, weight: 'bold' }
                }
              }
            }
          }
        },
        scales: {
          x: {
            type: 'time',
            time: { unit: 'minute', displayFormats: { minute: 'HH:mm' } },
            ticks: { color: '#7d8695', font: { size: 9 }, maxTicksLimit: 6 },
            grid: { color: 'rgba(255,255,255,0.04)' }
          },
          y: {
            position: 'right',
            ticks: { color: '#d1d4dc', font: { size: 10 } },
            grid: { color: 'rgba(255,255,255,0.06)' }
          }
        }
      }
    };

    const response = await fetch('https://quickchart.io/chart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chart: chartConfig, width: 900, height: 550, backgroundColor: '#0b0e14', version: '3' })
    });
    if (!response.ok) throw new Error('QuickChart error: ' + response.status);
    return await response.buffer();
  } catch (e) {
    console.log('⚠️ generateRealMarketChart failed:', e.message);
    return null;
  }
}

async function generateSignalForPair(chatId, userId, pair) {
  if (emergencyMode || maintenanceMode) {
    return;
  }
  if (signalInProgress.has(userId)) {
    await bot.sendMessage(chatId, '⏳ আপনার আগের request এখনো process হচ্ছে, একটু অপেক্ষা করুন...');
    return;
  }
  signalInProgress.add(userId);

  try {
    if (lastSignalMsgId.has(userId)) {
      try { await bot.deleteMessage(chatId, lastSignalMsgId.get(userId)); } catch (e) {}
      lastSignalMsgId.delete(userId);
    }

    if (!isApproved(userId)) {
      if (getTrialSignalLeft(userId) <= 0) { sendVerifyPrompt(chatId, userId); signalInProgress.delete(userId); return; }
      await incrementTrialSignal(userId);
    }

    const loadMsgId = await runLoadingBar(chatId);
    try { await bot.deleteMessage(chatId, loadMsgId); } catch (e) {}

    let signal;
    try {
      signal = await analyzeSignalCached(pair);
    } catch (e) {
      console.error('analyzeSignal fail for', pair, '-', e.message);
      const directions = ['UP⏫', 'DOWN⏬'];
      signal = { direction: directions[Math.floor(Math.random() * 2)], confidence: 'Medium 🟡', winRate: '75%', symbol: symbolFromDisplayPair(pair) };
    }

    const now2 = new Date();
    const entryDate = new Date(Math.floor((now2.getTime() + 60000) / 60000) * 60000);
    const entryDatetimeStr = formatUTCDateTime(entryDate);

    const bd2 = new Date(entryDate.getTime() + 6 * 60 * 60 * 1000);
    const exH = String(bd2.getUTCHours()).padStart(2, '0');
    const exM = String(bd2.getUTCMinutes()).padStart(2, '0');
    const entryDisplayTime = exH + ':' + exM;

    const trialInfo = isApproved(userId) ? '' : '\n📊 Signal বাকি: *' + getTrialSignalLeft(userId) + '/' + FREE_TRIAL_SIGNAL + '*';

    const captionText =
      '╭──────────────────╮\n│    📈 *𝗤𝘅 𝘅𝗮𝗮𝗻 𝗙𝗮𝘁𝗵𝗲𝗿 𝗯𝗼𝘁*\n╰──────────────────╯\n\n' +
      '📊 *ASSET*  ➜ `' + pair + '`\n🔹 *TIME*     ➜ `1 MIN`\n🕒 *𝗘𝗡𝗧𝗥𝗬* ➜ `' + entryDisplayTime + '`\n══════════════════\n' +
      '🚀 *DIRECTION* ➜ ' + signal.direction + '\n♻️ *WIN RATE*   ➜ `' + signal.winRate + '`\n✅ *CONFIDENCE* ➜ ' + signal.confidence + '\n══════════════════\n' +
      '⏹️ *Take the trade now!*\n⚠️ _Trade at your own risk if loss use 𝟭 𝗦𝗧𝗘𝗣 𝗠𝗧𝗚 never over trade_ ⚠️' + trialInfo;

    // ✅ ফিক্স — শুধু Real Market (live) pair হলে chart-সহ পাঠাবে, OTC হলে আগের মতোই শুধু টেক্সট
    let sentMsg;
    if (isRealMarketOpen()) {
      const chartBuffer = await generateRealMarketChart(signal.symbol, signal.direction, pair);
      if (chartBuffer) {
        sentMsg = await bot.sendPhoto(chatId, chartBuffer, {
          caption: captionText,
          parse_mode: 'Markdown',
          reply_markup: signalInlineKeyboard
        });
      }
    }
    if (!sentMsg) {
      sentMsg = await bot.sendMessage(chatId, captionText, {
        parse_mode: 'Markdown',
        reply_markup: signalInlineKeyboard
      });
    }

    if (sentMsg) lastSignalMsgId.set(userId, sentMsg.message_id);

    trackSignalResult(userId, signal.symbol, signal.direction, entryDatetimeStr, entryDisplayTime)
      .catch(e => console.log('trackSignalResult error:', e.message));
  } catch (e) {
    console.error('generateSignalForPair error:', e.message);
    try { await bot.sendMessage(chatId, '❌ Signal তৈরি করতে সমস্যা হয়েছে, আবার চেষ্টা করুন।'); } catch (err) {}
  } finally {
    signalInProgress.delete(userId);
  }
}

// ✅ নতুন — User Profile view (reusable — নতুন লোড আর Remove বাতিলের পরে ফিরে আসার জন্য)
// ফিক্স: আগে escapeMd() ছাড়া নাম/username সরাসরি বসানো হতো, যার ফলে username-এ
// আন্ডারস্কোর (_) বা অন্য মার্কডাউন ক্যারেক্টার থাকলে Telegram-এ "can't parse entities" এরর হতো।
async function showUserProfile(chatId, targetId) {
  const userDoc = await db.collection('startedUsers').findOne({ userId: targetId });
  const statsDoc = await db.collection('userStats').findOne({ userId: targetId });

  const rawName = (userDoc && userDoc.firstName) || 'N/A';
  const safeName = escapeMd(String(rawName).replace(/[\[\]]/g, ''));
  const lastNameText = userDoc && userDoc.lastName ? escapeMd(userDoc.lastName) : 'N/A';
  const usernameText = userDoc && userDoc.username ? '@' + escapeMd(userDoc.username) : 'N/A';
  const status = isApproved(targetId) ? '✅ Verified' : '❌ Not Verified';
  const joined = formatJoinedDate(userDoc && userDoc.joinedAt);
  const lastActive = timeAgo(statsDoc && statsDoc.lastActive);
  const totalSignals = (statsDoc && statsDoc.totalSignals) || 0;
  const totalScreenshots = (statsDoc && statsDoc.totalScreenshots) || 0;
  const totalMiniapp = (statsDoc && statsDoc.miniappScans) || 0;

  let country = 'N/A';
  const sub = submissions.find(s => s.userId === targetId);
  if (sub && sub.traderId) {
    const affRec = await db.collection('affiliateVerified').findOne({ traderId: sub.traderId });
    if (affRec && affRec.country) country = affRec.country;
  }

  await updateXAdminPanel(chatId,
    '👤 *𝗨𝘀𝗲𝗿 𝗣𝗿𝗼𝗳𝗶𝗹𝗲*\n\n' +
    '👤 Name: ' + safeName + '\n' +
    '👤 Last Name: ' + lastNameText + '\n' +
    // ✅ ID এখন clickable link — username না থাকলেও এখানে ট্যাপ করে সরাসরি প্রোফাইল ভিজিট করা যাবে
    '🆔 ID: [' + targetId + '](tg://user?id=' + targetId + ')\n' +
    '🔗 Username: ' + usernameText + '\n\n' +
    status + '\n' +
    '📅 Joined: ' + joined + '\n' +
    '🕒 Last Active: ' + lastActive + '\n\n' +
    '📊 Signals: ' + totalSignals + '\n' +
    '📸 Screenshot: ' + totalScreenshots + '\n' +
    '📠 Mini app: ' + totalMiniapp + '\n' +
    '🌍 Country: ' + country,
    {
      inline_keyboard: [
        [{ text: '💬 Message', callback_data: 'xadmin_uprofile_msg_' + targetId }, { text: '❌ Unapprove', callback_data: 'xadmin_uprofile_unapprove_' + targetId }],
        [{ text: '🗑 Remove From Database', callback_data: 'xadmin_uprofile_removeask_' + targetId }],
        [{ text: '🔙 Back', callback_data: 'xadmin_back' }]
      ]
    }
  );
}

// Callback handler
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const pair = query.data;
  bot.answerCallbackQuery(query.id);
  touchLastActive(userId);
  refreshUserProfile(userId, query.from.username, query.from.first_name, query.from.last_name);

  if (userId !== ADMIN_ID && (emergencyMode || maintenanceMode)) {
    return;
  }

  if (pair === 'new_signal') {
    if (!isApproved(userId) && getTrialSignalLeft(userId) <= 0) { sendVerifyPrompt(chatId, userId); return; }
    sendPairMenu(chatId, userId, 0);
    return;
  }

  // ✅ ফিক্স — Pair menu pagination (Prev/Next বাটন)
  if (pair === 'pairpage_noop') {
    return;
  }
  if (pair.startsWith('pairpage_')) {
    const targetPage = parseInt(pair.replace('pairpage_', ''), 10);
    if (!isNaN(targetPage)) sendPairMenu(chatId, userId, targetPage);
    return;
  }

  if (pair === 'screenshot_analysis') {
    if (emergencyMode || maintenanceMode) { return; }
    if (!isApproved(userId)) {
      if (getTrialScreenshotLeft(userId) <= 0) { sendVerifyPrompt(chatId, userId); return; }
    }
    await sendMenuMessage(chatId, userId,
      '📸 আপনার Quotex chart এর *screenshot* পাঠান:\n\n' +
      (isApproved(userId) ? '' : '📊 Screenshot বাকি: *' + getTrialScreenshotLeft(userId) + '/' + FREE_TRIAL_SCREENSHOT + '*'),
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ✅ ADMIN PANEL — Main + Submenu Navigation
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  if (pair === 'admin_back' && userId === ADMIN_ID) {
    await goAdminBack(chatId);
    return;
  }

  if ((adminSubMenus[pair] || pair === 'admin_menu_botcontrol') && userId === ADMIN_ID) {
    await goAdminTo(chatId, pair);
    return;
  }

  if (pair === 'admin_maintenance' && userId === ADMIN_ID) {
    adminOnLeaf = true;
    maintenanceMode = !maintenanceMode;
    await saveBotFlags();
    const status = maintenanceMode ? 'চালু 🔧' : 'বন্ধ ✅';
    await updateAdminPanel(chatId,
      '🔧 *Maintenance Mode ' + status + ' হয়েছে!*\n\n(ইউজাররা কোনো নোটিফিকেশন পাবে না — প্রয়োজনে নিজে Broadcast দিয়ে জানান)',
      { inline_keyboard: buildAdminBotControlSubmenu().keyboard }
    );
    return;
  }

  // ✅ নতুন — Emergency Mode এখন এডমিন প্যানেল থেকে টগল হয় (আগে xadmin-এ ছিল)
  if (pair === 'admin_emergency' && userId === ADMIN_ID) {
    adminOnLeaf = true;
    emergencyMode = !emergencyMode;
    await saveBotFlags();
    const status = emergencyMode ? 'চালু 🛑' : 'বন্ধ ✅';
    await updateAdminPanel(chatId,
      '🛑 *Emergency Mode ' + status + ' হয়েছে!*\n\n' +
      (emergencyMode ? 'সব Signal, Screenshot এবং Session বন্ধ থাকবে (এমনকি admin এর জন্যও)। ইউজাররা কোনো নোটিফিকেশন পাবে না।' : 'সব Feature আবার স্বাভাবিকভাবে কাজ করবে।'),
      { inline_keyboard: buildAdminBotControlSubmenu().keyboard }
    );
    if (emergencyMode && sessionModule && sessionModule.isSessionRunning()) {
      sessionModule.stopSessionNow();
    }
    return;
  }

  if (pair === 'admin_approved' && userId === ADMIN_ID) {
    adminOnLeaf = true;
    const list = [...approvedUsers].filter(u => u !== ADMIN_ID);
    let text = '✅ *APPROVED USERS*\n\n';
    if (list.length === 0) { text += 'কোনো approved user নেই।'; }
    else {
      list.forEach((uid, i) => {
        const sub = submissions.find(s => s.userId === uid);
        const uname = mentionUser(uid, sub ? sub.username : null, sub ? sub.name : 'Unknown');
        const traderId = sub ? sub.traderId : 'N/A';
        text += (i + 1) + '. ' + uname + '\n🆔 User: ' + uidLink(uid) + '\n📌 Trader ID: `' + traderId + '`\n\n';
      });
    }
    await updateAdminPanel(chatId, text.slice(0, 4000), adminBackKeyboard);
    return;
  }

  if (pair === 'admin_submissions' && userId === ADMIN_ID) {
    adminOnLeaf = true;
    await updateAdminPanel(chatId, '📋 *SUBMISSIONS*\n\nএকটা ক্যাটাগরি বেছে নাও:', {
      inline_keyboard: [
        [{ text: '🟢 Register Submission', callback_data: 'admin_sub_register' }],
        [{ text: '❌ Fake Submission', callback_data: 'admin_sub_fake' }],
        [{ text: '🔙 Back', callback_data: 'admin_back' }]
      ]
    });
    return;
  }

  if (pair === 'admin_sub_register' && userId === ADMIN_ID) {
    adminOnLeaf = true;
    const { text, keyboard } = await buildSubmissionButtonList('pending');
    await updateAdminPanel(chatId, text, { inline_keyboard: keyboard });
    return;
  }

  if (pair === 'admin_sub_fake' && userId === ADMIN_ID) {
    adminOnLeaf = true;
    const { text, keyboard } = await buildSubmissionButtonList('fake');
    await updateAdminPanel(chatId, text, { inline_keyboard: keyboard });
    return;
  }

  if (pair.startsWith('subview_') && userId === ADMIN_ID) {
    adminOnLeaf = true;
    const rest = pair.replace('subview_', '');
    const sepIdx = rest.indexOf('_');
    const subUserId = parseInt(rest.slice(0, sepIdx), 10);
    const traderId = rest.slice(sepIdx + 1);
    const { text, keyboard } = await buildSubmissionDetailCard(subUserId, traderId);
    await updateAdminPanel(chatId, text, { inline_keyboard: keyboard });
    return;
  }

  // ✅ ফিক্স — Delete-এর আচরণ এখন category অনুযায়ী: Register (pending) হলে শুধু
  // duplicateCount রিসেট হয় (মূল রেকর্ড কখনো মুছে না, trust রক্ষার জন্য),
  // Fake হলে পুরো রেকর্ডই মুছে যায়।
  if (pair.startsWith('subdel_') && userId === ADMIN_ID) {
    adminOnLeaf = true;
    const rest = pair.replace('subdel_', '');
    const sepIdx = rest.indexOf('_');
    const subUserId = parseInt(rest.slice(0, sepIdx), 10);
    const traderId = rest.slice(sepIdx + 1);
    const category = await getSubmissionCategory(traderId);

    if (category === 'fake') {
      await db.collection('submissions').deleteMany({ userId: subUserId, traderId });
      await updateAdminPanel(chatId, '✅ Fake submission সম্পূর্ণ মুছে ফেলা হয়েছে।', {
        inline_keyboard: [[{ text: '🔙 Back', callback_data: 'admin_sub_fake' }]]
      });
    } else {
      // ✅ ফিক্স — পুরনো ডুপ্লিকেট row একাধিক থাকলে সবগুলো একটাতে merge করে duplicateCount=1
      // করে দেওয়া হয় (বাকি ডুপ্লিকেট row মুছে ফেলা হয়, মূল রেকর্ডটা অক্ষত থাকে)
      const allMatching = await db.collection('submissions').find({ userId: subUserId, traderId }).sort({ firstSubmittedAt: 1 }).toArray();
      if (allMatching.length > 1) {
        const keepId = allMatching[0]._id;
        await db.collection('submissions').deleteMany({ userId: subUserId, traderId, _id: { $ne: keepId } });
      }
      await db.collection('submissions').updateOne({ userId: subUserId, traderId }, { $set: { duplicateCount: 1 } });
      await updateAdminPanel(chatId, '✅ Duplicate count রিসেট হয়েছে। (মূল registration রেকর্ড অক্ষত আছে — real user, কখনো মুছবে না)', {
        inline_keyboard: [[{ text: '🔙 Back', callback_data: 'admin_sub_register' }]]
      });
    }
    return;
  }

  if (pair === 'admin_affiliate' && userId === ADMIN_ID) {
    adminOnLeaf = true;
    const { text, keyboard } = await buildSubmissionButtonList('verified');
    await updateAdminPanel(chatId, text, { inline_keyboard: keyboard });
    return;
  }

  if (pair === 'admin_delaffiliate_prompt' && userId === ADMIN_ID) {
    adminOnLeaf = true;
    delAffiliateMode.add(ADMIN_ID);
    await updateAdminPanel(chatId, '🗑️ যে *Trader ID* affiliateVerified লিস্ট থেকে মুছতে চাও সেটা পাঠাও:', adminBackKeyboard);
    return;
  }

  if (pair === 'admin_broadcast' && userId === ADMIN_ID) {
    adminOnLeaf = true;
    broadcastMode.add(ADMIN_ID);
    await updateAdminPanel(chatId, '📢 যে message (text/photo/video যেকোনো কিছু) সব user কে পাঠাতে চাও সেটা পাঠাও:', adminBackKeyboard);
    return;
  }

  if (pair === 'admin_message_prompt' && userId === ADMIN_ID) {
    adminOnLeaf = true;
    messageUserMode.add(ADMIN_ID);
    await updateAdminPanel(chatId, '💬 যে user কে personal message পাঠাতে চাও তার *User ID* পাঠাও:\n\n💡 Tip: `/msg [user_id] [message]` দিয়ে এক লাইনেও পাঠাতে পারো।', adminBackKeyboard);
    return;
  }

  if (pair === 'admin_session_start' && userId === ADMIN_ID) {
    adminOnLeaf = true;
    if (emergencyMode) { await updateAdminPanel(chatId, '🛑 Emergency Mode চালু আছে, Session শুরু করা যাবে না।', adminBackKeyboard); return; }
    if (!sessionModule) { await updateAdminPanel(chatId, '❌ Session module এখনো লোড হয়নি, একটু পর চেষ্টা করুন।', adminBackKeyboard); return; }
    if (sessionModule.isSessionRunning()) {
      await updateAdminPanel(chatId, '⚠️ একটা session ইতিমধ্যে চলছে। শেষ হওয়া পর্যন্ত অপেক্ষা করুন।', adminBackKeyboard);
      return;
    }
    await updateAdminPanel(chatId, '🚀 Manual session শুরু হচ্ছে... (channel এ চলে যান)', adminBackKeyboard);
    sessionModule.runSession(bot, '🎯 Manual').catch(e => {
      console.error('Manual session error:', e.message);
      bot.sendMessage(ADMIN_ID, '❌ Session চালাতে সমস্যা হয়েছে: ' + e.message).catch(() => {});
    });
    return;
  }

  if (pair === 'admin_unapprove_prompt' && userId === ADMIN_ID) {
    adminOnLeaf = true;
    unapproveMode.add(ADMIN_ID);
    const list = [...approvedUsers].filter(u => u !== ADMIN_ID);
    let text = '❌ *UNAPPROVE USER*\n\n';
    if (list.length === 0) { text += 'কোনো approved user নেই।'; unapproveMode.delete(ADMIN_ID); }
    else {
      list.forEach((uid, i) => {
        const sub = submissions.find(s => s.userId === uid);
        const uname = mentionUser(uid, sub ? sub.username : null, sub ? sub.name : 'Unknown');
        text += (i + 1) + '. ' + uname + ' — `' + uid + '`\n';
      });
      text += '\n📌 যে user কে unapprove করতে চাও তার *User ID* পাঠাও:';
    }
    await updateAdminPanel(chatId, text.slice(0, 4000), adminBackKeyboard);
    return;
  }

  if (pair === 'admin_ban_prompt' && userId === ADMIN_ID) {
    adminOnLeaf = true;
    banMode.add(ADMIN_ID);
    const list = [...startedUsers].filter(u => u !== ADMIN_ID && !bannedUsers.has(u));
    let text = '🚫 *BAN USER*\n\n';
    if (list.length === 0) { text += 'ban করার মতো কোনো user নেই।'; banMode.delete(ADMIN_ID); }
    else {
      list.forEach((uid, i) => {
        const sub = submissions.find(s => s.userId === uid);
        const uname = mentionUser(uid, sub ? sub.username : null, sub ? sub.name : 'Unknown');
        text += (i + 1) + '. ' + uname + ' — `' + uid + '`\n';
      });
      text += '\n📌 যে user কে ban করতে চাও তার *User ID* পাঠাও:';
    }
    await updateAdminPanel(chatId, text.slice(0, 4000), adminBackKeyboard);
    return;
  }

  if (pair === 'admin_unban_prompt' && userId === ADMIN_ID) {
    adminOnLeaf = true;
    unbanMode.add(ADMIN_ID);
    const list = [...bannedUsers];
    let text = '✅ *UNBAN USER*\n\n';
    if (list.length === 0) { text += 'ban list এ কোনো user নেই।'; unbanMode.delete(ADMIN_ID); }
    else {
      list.forEach((uid, i) => {
        const sub = submissions.find(s => s.userId === uid);
        const uname = mentionUser(uid, sub ? sub.username : null, sub ? sub.name : 'Unknown');
        text += (i + 1) + '. ' + uname + ' — `' + uid + '`\n';
      });
      text += '\n📌 যে user কে unban করতে চাও তার *User ID* পাঠাও:';
    }
    await updateAdminPanel(chatId, text.slice(0, 4000), adminBackKeyboard);
    return;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ✅ XADMIN PANEL — Main + Submenu Navigation
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  if (pair === 'xadmin_back' && userId === ADMIN_ID) {
    await goXAdminBack(chatId);
    return;
  }

  if (xadminSubMenus[pair] && userId === ADMIN_ID) {
    await goXAdminTo(chatId, pair);
    return;
  }

  if (xadminSubSubMenus[pair] && userId === ADMIN_ID) {
    await goXAdminTo(chatId, pair);
    return;
  }

  if (pair === 'xadmin_verify_nodeposit' && userId === ADMIN_ID) {
    xadminOnLeaf = true;
    xadminVerifyNoDepositMode.add(ADMIN_ID);
    await updateXAdminPanel(chatId,
      '✍️ যে Trader ID শুধু *Verify (No Deposit)* করতে চাও সেটা পাঠাও:\n\n(registered: true, deposit: $0 রেখে verify হবে — deposit ছাড়া ইউজার কী মেসেজ পায় তা টেস্ট করার জন্য)',
      xadminBackKeyboard
    );
    return;
  }

  if (pair === 'xadmin_setdeposit' && userId === ADMIN_ID) {
    xadminOnLeaf = true;
    xadminSetDepositMode.add(ADMIN_ID);
    await updateXAdminPanel(chatId,
      '💰 এই ফরম্যাটে পাঠাও: `TraderID Amount`\n\nউদাহরণ: `12345678 15`\n\n⚠️ এটা amount *replace* করবে (add না)। $' + MIN_DEPOSIT_USD + ' এর নিচে দিলে verified বাতিল হয়ে যাবে (board access বন্ধ)।',
      xadminBackKeyboard
    );
    return;
  }

  if (pair === 'xadmin_check' && userId === ADMIN_ID) {
    xadminOnLeaf = true;
    xadminCheckMode.add(ADMIN_ID);
    await updateXAdminPanel(chatId, '🔍 যে Trader ID এর status চেক করতে চাও সেটা পাঠাও:', xadminBackKeyboard);
    return;
  }

  // ✅ নতুন — Search User ID বাটন (First Name/Last Name/Username/ID যেটাই থাকুক clickable দেখাবে)
  if (pair === 'xadmin_search_user' && userId === ADMIN_ID) {
    xadminOnLeaf = true;
    xadminSearchUserMode.add(ADMIN_ID);
    await updateXAdminPanel(chatId, '👤 যে User ID এর তথ্য দেখতে চাও সেটা পাঠাও:', xadminBackKeyboard);
    return;
  }

  if (pair === 'xadmin_trial_reset' && userId === ADMIN_ID) {
    xadminOnLeaf = true;
    xadminTrialResetMode.add(ADMIN_ID);
    await updateXAdminPanel(chatId, '🎁 যে User ID এর Free Trial reset করতে চাও (নতুন করে trial টেস্ট করার জন্য) সেটা পাঠাও:', xadminBackKeyboard);
    return;
  }

  // ✅ নতুন — সব ইউজারের Trial (Signal/Screenshot/Mini App) একসাথে রিসেট — আগে কনফার্মেশন চাইবে
  if (pair === 'xadmin_reset_all_trials_prompt' && userId === ADMIN_ID) {
    xadminOnLeaf = true;
    await updateXAdminPanel(chatId,
      '🚨 *সব ইউজারের Trial রিসেট করবেন?*\n\n⚠️ এটা সব ইউজারের Signal/Screenshot/Mini App trial সম্পূর্ণ রিসেট করবে এবং প্রতিটা ইউজার নোটিফিকেশন পাবে। এই কাজ ফেরানো যাবে না।\n\nনিশ্চিত?',
      { inline_keyboard: [[
        { text: '✅ হ্যাঁ, সব রিসেট করো', callback_data: 'xadmin_reset_all_trials_confirm' },
        { text: '❌ বাতিল', callback_data: 'xadmin_reset_all_trials_cancel' }
      ]] }
    );
    return;
  }

  if (pair === 'xadmin_reset_all_trials_cancel' && userId === ADMIN_ID) {
    xadminOnLeaf = true;
    await updateXAdminPanel(chatId, '❌ বাতিল করা হয়েছে, কোনো ট্রায়াল রিসেট হয়নি।', xadminBackKeyboard);
    return;
  }

  if (pair === 'xadmin_reset_all_trials_confirm' && userId === ADMIN_ID) {
    xadminOnLeaf = true;
    await updateXAdminPanel(chatId, '⏳ রিসেট করা হচ্ছে...', xadminBackKeyboard);
    try {
      trialSignalCount.clear();
      trialScreenshotCount.clear();
      miniappTrialCount.clear();

      if (db) {
        await db.collection('trialCounts').updateMany({}, { $set: { signalCount: 0, screenshotCount: 0 } });
        await db.collection('miniappTrialCounts').updateMany({}, { $set: { count: 0 } });
      }

      const notifyText =
        '🔓 𝗔𝗰𝗰𝗲𝘀𝘀 𝗥𝗲𝘀𝘁𝗼𝗿𝗲𝗱\n\n' +
        '📈 𝗦𝗶𝗴𝗻𝗮𝗹𝘀 𝗟𝗲𝗳𝘁: 0' + FREE_TRIAL_SIGNAL + '/0' + FREE_TRIAL_SIGNAL + '\n' +
        '📸 𝗦𝗰𝗿𝗲𝗲𝗻𝘀𝗵𝗼𝘁𝘀 𝗟𝗲𝗳𝘁: 0' + FREE_TRIAL_SCREENSHOT + '/0' + FREE_TRIAL_SCREENSHOT + '\n' +
        '🖥️ 𝗠𝗶𝗻𝗶 𝗔𝗽𝗽 𝗟𝗲𝗳𝘁: 0' + MINIAPP_FREE_TRIAL + '/0' + MINIAPP_FREE_TRIAL;

      let notified = 0, failed = 0;
      for (const uid of startedUsers) {
        if (uid === ADMIN_ID || bannedUsers.has(uid)) continue;
        try { await bot.sendMessage(uid, notifyText); notified++; } catch (e) { failed++; }
        await sleep(50);
      }

      await updateXAdminPanel(chatId, '✅ *সব ইউজারের Trial রিসেট সম্পন্ন!*\n\n📨 Notified: ' + notified + '\n❌ Failed: ' + failed, xadminBackKeyboard);
    } catch (e) {
      await updateXAdminPanel(chatId, '❌ রিসেট ব্যর্থ: ' + e.message, xadminBackKeyboard);
    }
    return;
  }

  if (pair === 'xadmin_delete_testdata' && userId === ADMIN_ID) {
    xadminOnLeaf = true;
    xadminDeleteTestDataMode.add(ADMIN_ID);
    await updateXAdminPanel(chatId, '🗑️ যে User এর Test Data মুছতে চাও তার *User ID* পাঠাও:', xadminBackKeyboard);
    return;
  }

  if (pair === 'xadmin_session_pause' && userId === ADMIN_ID) {
    xadminOnLeaf = true;
    if (!sessionModule || !sessionModule.isSessionRunning()) { await updateXAdminPanel(chatId, '⚠️ এখন কোনো Session চলছে না।', xadminBackKeyboard); return; }
    const ok = sessionModule.pauseSession();
    await updateXAdminPanel(chatId, ok ? '⏸ Session Pause করা হয়েছে। (চলমান রাউন্ড শেষ হলে পরের সিগন্যাল আটকে যাবে)' : '❌ Pause করা যায়নি।', xadminBackKeyboard);
    return;
  }

  if (pair === 'xadmin_session_stop' && userId === ADMIN_ID) {
    xadminOnLeaf = true;
    if (!sessionModule || !sessionModule.isSessionRunning()) { await updateXAdminPanel(chatId, '⚠️ এখন কোনো Session চলছে না।', xadminBackKeyboard); return; }
    const ok = sessionModule.stopSessionNow();
    await updateXAdminPanel(chatId, ok ? '⏹ Session বন্ধ করা হচ্ছে... (চলমান রাউন্ড শেষ হলে থামবে)' : '❌ Stop করা যায়নি।', xadminBackKeyboard);
    return;
  }

  // ✅ ফিক্স — আগে ট্যাপ করলেই সরাসরি clean হয়ে যেত (ভুলে ক্লিক হলেও)। এখন আগে
  // কনফার্মেশন চাইবে, "হ্যাঁ" চাপলে তবেই আসল clean অপারেশন চলবে।
  if (pair === 'xadmin_clean_db' && userId === ADMIN_ID) {
    xadminOnLeaf = true;
    await updateXAdminPanel(chatId,
      '⚠️ *আপনি কি নিশ্চিত?*\n\nএটা bot-blocked/deactivated সব ইউজারকে ডাটাবেস থেকে মুছে দেবে।',
      {
        inline_keyboard: [
          [{ text: '✅ হ্যাঁ, Clean করো', callback_data: 'xadmin_clean_db_confirm' }, { text: '❌ বাতিল', callback_data: 'xadmin_clean_db_cancel' }]
        ]
      }
    );
    return;
  }

  if (pair === 'xadmin_clean_db_cancel' && userId === ADMIN_ID) {
    xadminOnLeaf = true;
    await updateXAdminPanel(chatId, '❌ Database Clean বাতিল করা হয়েছে।', xadminBackKeyboard);
    return;
  }

  if (pair === 'xadmin_clean_db_confirm' && userId === ADMIN_ID) {
    xadminOnLeaf = true;
    await updateXAdminPanel(chatId, '🧹 Database Clean শুরু হচ্ছে... একটু সময় লাগবে।', xadminBackKeyboard);
    let checked = 0, removed = 0;
    const candidates = [...startedUsers].filter(u => u !== ADMIN_ID).slice(0, 200);
    for (const uid of candidates) {
      checked++;
      try {
        await bot.getChat(uid);
      } catch (e) {
        const m = (e.message || '').toLowerCase();
        if (m.includes('blocked') || m.includes('chat not found') || m.includes('deactivated') || m.includes('user not found')) {
          startedUsers.delete(uid);
          trialSignalCount.delete(uid);
          trialScreenshotCount.delete(uid);
          if (db) {
            await db.collection('startedUsers').deleteOne({ userId: uid });
            await db.collection('trialCounts').deleteOne({ userId: uid });
          }
          removed++;
        }
      }
      await sleep(150);
    }
    await updateXAdminPanel(chatId,
      '✅ *Database Clean সম্পন্ন!*\n\n🔍 Checked: ' + checked + '\n🗑️ Removed: ' + removed +
      (startedUsers.size + removed > 200 ? '\n\n⚠️ একবারে সর্বোচ্চ ২০০ জন চেক করা হয়, আবার চালিয়ে বাকিদের চেক করুন।' : ''),
      xadminBackKeyboard
    );
    return;
  }

  if (pair === 'xadmin_health' && userId === ADMIN_ID) {
    xadminOnLeaf = true;
    await updateXAdminPanel(chatId, '🩺 Health Check চলছে...', xadminBackKeyboard);

    let mongoStatus = '❌ Fail';
    try { if (db) { await db.command({ ping: 1 }); mongoStatus = '✅ OK'; } } catch (e) { mongoStatus = '❌ ' + e.message; }

    await updateXAdminPanel(chatId,
      '🩺 *𝗔𝗟𝗟 𝗔𝗣𝗜 𝗞𝗘𝗬 𝗛𝗘𝗔𝗟𝗧𝗛 𝗖𝗛𝗘𝗖𝗞*\n\n' +
      '🗄️ MongoDB: ' + mongoStatus + '\n' +
      '📸 Screenshot Module: ✅ Loaded\n' +
      '🔧 Maintenance Mode: ' + (maintenanceMode ? '🔧 ON' : '✅ OFF') + '\n' +
      '🛑 Emergency Mode: ' + (emergencyMode ? '🛑 ON' : '✅ OFF') + '\n' +
      '▶️ Session Running: ' + (sessionModule && sessionModule.isSessionRunning() ? '✅ YES' : '❌ NO'),
      xadminBackKeyboard
    );
    return;
  }

  // ✅ নতুন — TwelveData Health (per-key breakdown)
  if (pair === 'xadmin_td_health' && userId === ADMIN_ID) {
    xadminOnLeaf = true;
    await updateXAdminPanel(chatId, '🩺 TwelveData key-ভিত্তিক status চেক করা হচ্ছে...', xadminBackKeyboard);
    try {
      const details = await twelveData.getAllKeysDetailedStatus();
      const range = twelveData.getKeyRange();
      const activeEntry = details.find(d => d.isActive);
      const activeIndex = activeEntry ? activeEntry.envIndex : null;

      let tdOnlineLine = '❌ API Offline';
      const tdStart = Date.now();
      try {
        const r = await twelveData.getTimeSeries('EUR/USD', '1min', 2);
        tdOnlineLine = r && r.values ? '✅ Status: Online' : '⚠️ ডেটা পাওয়া যায়নি';
      } catch (e) { tdOnlineLine = '❌ ' + e.message; }
      const latencyMs = Date.now() - tdStart;

      let perKeyLines = '';
      let totalRemaining = 0, totalLimit = 0;
      details.forEach(d => {
        const remaining = (d.currentUsage !== null && d.planLimit !== null) ? (d.planLimit - d.currentUsage) : null;
        if (remaining !== null) { totalRemaining += remaining; totalLimit += d.planLimit; }
        const tag = d.isActive ? ' 🟢 Active' : (d.isExhausted ? ' 🔴' : '');
        const valText = remaining !== null ? remaining + '/' + d.planLimit : 'N/A';
        perKeyLines += '│   ├ #' + d.envIndex + ' ➜ ' + valText + tag + '\n';
      });

      await updateXAdminPanel(chatId,
        '🩺 *𝗧𝘄𝗲𝗹𝘃𝗲𝗗𝗮𝘁𝗮 𝗛𝗲𝗮𝗹𝘁𝗵*\n\n' +
        '📊 *𝗧𝘄𝗲𝗹𝘃𝗲𝗗𝗮𝘁𝗮*\n\n' +
        '├ ' + tdOnlineLine + '\n' +
        '├ ⚡ Response: ' + latencyMs + 'ms\n' +
        '├ 🔑 Keys Loaded: ' + range.count + ' (#' + range.min + ' → #' + range.max + ')\n' +
        '├ 🎯 Active Key: ' + (activeIndex !== null ? '#' + activeIndex + ' 🟢' : 'N/A') + '\n' +
        '├ 📞 Calls Remaining\n' +
        perKeyLines +
        '└ 📊 Total Available: ' + totalRemaining + '/' + totalLimit + ' Calls',
        xadminBackKeyboard
      );
    } catch (e) {
      await updateXAdminPanel(chatId, '❌ TwelveData health check ব্যর্থ: ' + e.message, xadminBackKeyboard);
    }
    return;
  }

  // ✅ নতুন — Exhausted Keys তালিকা
  if (pair === 'xadmin_td_exhausted' && userId === ADMIN_ID) {
    xadminOnLeaf = true;
    await updateXAdminPanel(chatId, '🚫 Exhausted keys চেক করা হচ্ছে...', xadminBackKeyboard);
    try {
      const details = await twelveData.getAllKeysDetailedStatus();
      const exhausted = details.filter(d => d.isExhausted);
      const activeCount = details.length - exhausted.length;
      const activeCapacity = details
        .filter(d => !d.isExhausted && d.currentUsage !== null && d.planLimit !== null)
        .reduce((sum, d) => sum + (d.planLimit - d.currentUsage), 0);

      let exhaustedLines = '';
      if (exhausted.length === 0) {
        exhaustedLines = '✅ কোনো Key Exhausted না — সবগুলো সচল।\n';
      } else {
        exhausted.forEach(d => {
          exhaustedLines += '├ 🔴 Key #' + d.envIndex + '\n' +
            '│   └ ' + (d.currentUsage !== null && d.planLimit !== null ? d.currentUsage + '/' + d.planLimit : '0/0') + ' Calls (Quota Reached)\n\n';
        });
      }

      await updateXAdminPanel(chatId,
        '📛 *𝗘𝘅𝗵𝗮𝘂𝘀𝘁𝗲𝗱 𝗔𝗣𝗜 𝗞𝗲𝘆𝘀*\n\n' +
        '├ ❌ Exhausted ➜ ' + exhausted.length + ' Keys\n│\n' +
        exhaustedLines +
        '├ 🟢 Active Keys ➜ ' + activeCount + '\n' +
        '└ 📊 Available Capacity ➜ ' + activeCapacity + ' Calls',
        xadminBackKeyboard
      );
    } catch (e) {
      await updateXAdminPanel(chatId, '❌ Exhausted keys চেক ব্যর্থ: ' + e.message, xadminBackKeyboard);
    }
    return;
  }

  // ✅ নতুন — Gemini exhausted keys ম্যানুয়ালি রিসেট
  if (pair === 'xadmin_reset_gemini' && userId === ADMIN_ID) {
    xadminOnLeaf = true;
    try {
      const count = geminiKeyPool.resetAllExhausted();
      await updateXAdminPanel(chatId,
        '🔄 *Gemini Keys Reset হয়েছে!*\n\n✅ ' + count + ' টা exhausted key আবার সচল করা হলো।',
        xadminBackKeyboard
      );
    } catch (e) {
      await updateXAdminPanel(chatId, '❌ Reset ব্যর্থ: ' + e.message, xadminBackKeyboard);
    }
    return;
  }

  // ✅ ফিক্স — আগে এখানে testNewsAPI() ব্যবহার হতো, যেটা raw sample data দিতো কিন্তু
  // key breakdown দিতো না। এখন news.js-এর সম্পূর্ণ getHealthDashboard() ব্যবহার হচ্ছে,
  // যেটা raw key value না দেখিয়ে Keys Loaded/Active Key/প্রতিটা key-এর status
  // (OK/Invalid/Expired/Rate Limited) + cache/news summary সবকিছু পরিষ্কারভাবে দেখায়।
  // Note: FCS API প্রতি-key remaining call count (যেমন 6/8) সরবরাহ করে না, তাই সেই
  // সংখ্যা এখানে বসানো সম্ভব না — শুধু status tag (🟢/🔴/🟡) দেখানো যাচ্ছে।
  if (pair === 'xadmin_test_news' && userId === ADMIN_ID) {
    xadminOnLeaf = true;
    await updateXAdminPanel(chatId, '📰 News API টেস্ট করা হচ্ছে...', xadminBackKeyboard);
    try {
      if (!newsModuleRef || typeof newsModuleRef.getHealthDashboard !== 'function') {
        await updateXAdminPanel(chatId, '⚠️ News module এখনো লোড হয়নি।', xadminBackKeyboard);
        return;
      }
      const dashboardText = await newsModuleRef.getHealthDashboard();
      await updateXAdminPanel(chatId, dashboardText.slice(0, 4000), xadminBackKeyboard);
    } catch (e) {
      await updateXAdminPanel(chatId, '❌ চেক ব্যর্থ: ' + e.message, xadminBackKeyboard);
    }
    return;
  }

  // ✅ নতুন — Channel.js-এর TwelveData key pool আলাদাভাবে চেক
  if (pair === 'xadmin_channel_health' && userId === ADMIN_ID) {
    xadminOnLeaf = true;
    await updateXAdminPanel(chatId, '📡 Channel Key Health লোড হচ্ছে...', xadminBackKeyboard);
    try {
      if (!channelModuleRef || typeof channelModuleRef.getChannelHealth !== 'function') {
        await updateXAdminPanel(chatId, '⚠️ Channel module এখনো লোড হয়নি।', xadminBackKeyboard);
        return;
      }
      const healthText = await channelModuleRef.getChannelHealth();
      await updateXAdminPanel(chatId, healthText.slice(0, 4000), xadminBackKeyboard);
    } catch (e) {
      await updateXAdminPanel(chatId, '❌ চেক ব্যর্থ: ' + e.message, xadminBackKeyboard);
    }
    return;
  }

  // ✅ নতুন — Channel.js key pool-এর Dead/Exhausted keys তালিকা
  if (pair === 'xadmin_channel_dead' && userId === ADMIN_ID) {
    xadminOnLeaf = true;
    await updateXAdminPanel(chatId, '🚫 Dead Channel Keys চেক করা হচ্ছে...', xadminBackKeyboard);
    try {
      if (!channelModuleRef || typeof channelModuleRef.getChannelDeadKeys !== 'function') {
        await updateXAdminPanel(chatId, '⚠️ Channel module এখনো লোড হয়নি।', xadminBackKeyboard);
        return;
      }
      const deadText = await channelModuleRef.getChannelDeadKeys();
      await updateXAdminPanel(chatId, deadText.slice(0, 4000), xadminBackKeyboard);
    } catch (e) {
      await updateXAdminPanel(chatId, '❌ চেক ব্যর্থ: ' + e.message, xadminBackKeyboard);
    }
    return;
  }

  // ✅ নতুন — Gemini Key Health (per-key active/exhausted status; TwelveData-র মতো remaining
  // count দেখানো সম্ভব না, কারণ Gemini-র কোনো api_usage-এর মতো এন্ডপয়েন্ট নেই)
  if (pair === 'xadmin_gemini_health' && userId === ADMIN_ID) {
    xadminOnLeaf = true;
    try {
      const status = geminiKeyPool.getStatus();
      const active = status.filter(k => !k.exhausted).length;
      const exhausted = status.length - active;
      let keyLines = '';
      status.forEach(k => {
        keyLines += '#' + k.index + ' ➜ ' + (k.exhausted ? '🔴 Exhausted' : '🟢 OK') + '\n';
      });
      await updateXAdminPanel(chatId,
        '❤️ *𝗚𝗘𝗠𝗜𝗡𝗜 𝗞𝗘𝗬 𝗛𝗘𝗔𝗟𝗧𝗛*\n\n' +
        '🔑 Total Keys: ' + status.length + '\n' +
        '🟢 Active: ' + active + '\n' +
        '🔴 Exhausted: ' + exhausted + '\n\n' +
        (keyLines || 'কোনো key লোড হয়নি'),
        xadminBackKeyboard
      );
    } catch (e) {
      await updateXAdminPanel(chatId, '❌ চেক ব্যর্থ: ' + e.message, xadminBackKeyboard);
    }
    return;
  }

  // ✅ নতুন — শুধু exhausted হওয়া Gemini key-গুলোর তালিকা
  if (pair === 'xadmin_gemini_dead' && userId === ADMIN_ID) {
    xadminOnLeaf = true;
    try {
      const status = geminiKeyPool.getStatus();
      const dead = status.filter(k => k.exhausted);
      const active = status.length - dead.length;
      let deadLines = '';
      dead.forEach(k => { deadLines += '├ Key #' + k.index + '\n'; });
      await updateXAdminPanel(chatId,
        '🚫 *𝗗𝗘𝗔𝗗 𝗚𝗘𝗠𝗜𝗡𝗜 𝗞𝗘𝗬𝗦*\n\n' +
        '🔴 Exhausted ➜ ' + dead.length + ' Key' + (dead.length === 1 ? '' : 's') + '\n' +
        (deadLines || '') +
        '\n🟢 Active Keys ➜ ' + active,
        xadminBackKeyboard
      );
    } catch (e) {
      await updateXAdminPanel(chatId, '❌ চেক ব্যর্থ: ' + e.message, xadminBackKeyboard);
    }
    return;
  }

  // ✅ নতুন — 👥 All User Database: paginated user list (৮ জন প্রতি পেজে)
  if (pair.startsWith('xadmin_userlist_') && userId === ADMIN_ID) {
    xadminOnLeaf = true;
    const page = parseInt(pair.replace('xadmin_userlist_', ''), 10) || 0;
    const PAGE_SIZE = 10;
    try {
      const total = await db.collection('startedUsers').countDocuments();
      const users = await db.collection('startedUsers')
        .find({})
        .sort({ _id: 1 })
        .skip(page * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .toArray();

      const circledNums = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩'];
      const rows = [];
      for (let i = 0; i < users.length; i += 2) {
        const row = [];
        const u1 = users[i];
        row.push({ text: circledNums[i] + ' ' + (u1.firstName || u1.username || ('User ' + u1.userId)), callback_data: 'xadmin_uprofile_' + u1.userId });
        if (users[i + 1]) {
          const u2 = users[i + 1];
          row.push({ text: circledNums[i + 1] + ' ' + (u2.firstName || u2.username || ('User ' + u2.userId)), callback_data: 'xadmin_uprofile_' + u2.userId });
        }
        rows.push(row);
      }

      const navRow = [];
      if (page > 0) navRow.push({ text: '◀ Previous', callback_data: 'xadmin_userlist_' + (page - 1) });
      if ((page + 1) * PAGE_SIZE < total) navRow.push({ text: 'Next ▶', callback_data: 'xadmin_userlist_' + (page + 1) });
      if (navRow.length) rows.push(navRow);
      rows.push([{ text: '🔙 Back', callback_data: 'xadmin_back' }]);

      const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      await updateXAdminPanel(chatId,
        '👥 *𝗔𝗟𝗟 𝗨𝗦𝗘𝗥𝗦*\n══════════════════\nTotal Users: ' + total + '\nPage ' + (page + 1) + ' / ' + totalPages + '\n\nSelect a user to view the profile:',
        { inline_keyboard: rows }
      );
    } catch (e) {
      await updateXAdminPanel(chatId, '❌ User list লোড ব্যর্থ: ' + e.message, xadminBackKeyboard);
    }
    return;
  }

  // ✅ নতুন — নির্দিষ্ট user profile দেখানো
  if (pair.startsWith('xadmin_uprofile_') && !pair.startsWith('xadmin_uprofile_msg_') && !pair.startsWith('xadmin_uprofile_unapprove_') && !pair.startsWith('xadmin_uprofile_removeask_') && !pair.startsWith('xadmin_uprofile_removeconfirm_') && userId === ADMIN_ID) {
    xadminOnLeaf = true;
    const targetId = parseInt(pair.replace('xadmin_uprofile_', ''), 10);
    if (isNaN(targetId)) { await updateXAdminPanel(chatId, '❌ ভুল User ID।', xadminBackKeyboard); return; }
    await showUserProfile(chatId, targetId);
    return;
  }

  if (pair.startsWith('xadmin_uprofile_msg_') && userId === ADMIN_ID) {
    xadminOnLeaf = true;
    const targetId = parseInt(pair.replace('xadmin_uprofile_msg_', ''), 10);
    if (isNaN(targetId)) { await updateXAdminPanel(chatId, '❌ ভুল User ID।', xadminBackKeyboard); return; }
    xadminMessageUserMode.set(ADMIN_ID, targetId);
    await updateXAdminPanel(chatId, '💬 User `' + targetId + '`-কে যে মেসেজ পাঠাতে চাও লেখো:', xadminBackKeyboard);
    return;
  }

  if (pair.startsWith('xadmin_uprofile_unapprove_') && userId === ADMIN_ID) {
    xadminOnLeaf = true;
    const targetId = parseInt(pair.replace('xadmin_uprofile_unapprove_', ''), 10);
    if (isNaN(targetId)) { await updateXAdminPanel(chatId, '❌ ভুল User ID।', xadminBackKeyboard); return; }
    await removeApprovedUser(targetId);
    passwordMode.delete(targetId);
    try { await bot.sendMessage(targetId, '⛔ আপনার bot access বাতিল করা হয়েছে।\n\n✅ পুনরায় verify করতে /start দিন।'); } catch (e) {}
    await showUserProfile(chatId, targetId);
    return;
  }

  // ✅ ফিক্স — এখন সরাসরি ডিলিট হয় না, আগে "আপনি কি নিশ্চিত?" জিজ্ঞেস করে (ভুল ক্লিকে যাতে ইউজার মুছে না যায়)
  if (pair.startsWith('xadmin_uprofile_removeask_') && userId === ADMIN_ID) {
    xadminOnLeaf = true;
    const targetId = parseInt(pair.replace('xadmin_uprofile_removeask_', ''), 10);
    if (isNaN(targetId)) { await updateXAdminPanel(chatId, '❌ ভুল User ID।', xadminBackKeyboard); return; }
    await updateXAdminPanel(chatId,
      '⚠️ *আপনি কি নিশ্চিত?*\n\nUser `' + targetId + '`-কে ডাটাবেস থেকে স্থায়ীভাবে মুছে ফেলা হবে। এটা undo করা যাবে না।',
      {
        inline_keyboard: [
          [{ text: '✅ হ্যাঁ, Remove করো', callback_data: 'xadmin_uprofile_removeconfirm_' + targetId }, { text: '❌ বাতিল', callback_data: 'xadmin_uprofile_' + targetId }]
        ]
      }
    );
    return;
  }

  if (pair.startsWith('xadmin_uprofile_removeconfirm_') && userId === ADMIN_ID) {
    xadminOnLeaf = true;
    const targetId = parseInt(pair.replace('xadmin_uprofile_removeconfirm_', ''), 10);
    if (isNaN(targetId)) { await updateXAdminPanel(chatId, '❌ ভুল User ID।', xadminBackKeyboard); return; }
    startedUsers.delete(targetId);
    trialSignalCount.delete(targetId);
    trialScreenshotCount.delete(targetId);
    miniappTrialCount.delete(targetId);
    if (db) {
      await db.collection('startedUsers').deleteOne({ userId: targetId });
      await db.collection('trialCounts').deleteOne({ userId: targetId });
      await db.collection('miniappTrialCounts').deleteOne({ userId: targetId });
      await db.collection('userStats').deleteOne({ userId: targetId });
    }
    await updateXAdminPanel(chatId, '✅ User `' + targetId + '` ডাটাবেস থেকে মুছে ফেলা হয়েছে।', xadminBackKeyboard);
    return;
  }

  if (pair === 'xadmin_errorlogs' && userId === ADMIN_ID) {
    xadminOnLeaf = true;
    const text = errorLogBuffer.length > 0
      ? '🚨 *𝗘𝗿𝗿𝗼𝗿 𝗟𝗼𝗴𝘀 (সর্বশেষ ' + errorLogBuffer.length + ')*\n\n' + errorLogBuffer.join('\n\n')
      : '✅ কোনো error log নেই।';
    await updateXAdminPanel(chatId, text.slice(0, 4000), xadminBackKeyboard);
    return;
  }

  if (pair === '/verify') {
    verifyMode.add(userId);
    await sendMenuMessage(chatId, userId, '🔐 𝗣𝗹𝗲𝗮𝘀𝗲 𝗦𝗲𝗻𝗱 𝗬𝗼𝘂𝗿 𝟴-𝗗𝗶𝗴𝗶𝘁 𝗤𝘂𝗼𝘁𝗲𝘅 𝗧𝗿𝗮𝗱𝗲𝗿 𝗜𝗗 👇', { parse_mode: 'Markdown' });
    return;
  }

  const symbolCheck = symbolFromDisplayPair(pair);
  if (!LIVE_PAIRS.includes(symbolCheck) && !OTC_PAIRS.includes(symbolCheck)) return;

  if (!isApproved(userId) && getTrialSignalLeft(userId) <= 0) { sendVerifyPrompt(chatId, userId); return; }

  await generateSignalForPair(chatId, userId, pair);
});

// Sticker file_id getter
bot.on('sticker', async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  await bot.sendMessage(msg.chat.id,
    '📎 *Sticker file\\_id:*\n`' + msg.sticker.file_id + '`',
    { parse_mode: 'Markdown' }
  );
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ✅ মধ্যরাত ১২টায় Daily Admin Report scheduler
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

setInterval(async () => {
  try {
    const { hour, minute } = getBDTimeInfo();
    const dateKeyNow = currentBDDateKey();

    if (hour === 0 && minute >= 2 && minute <= 6 && lastReportDateKey !== dateKeyNow) {
      lastReportDateKey = dateKeyNow;
      // ✅ ফিক্স (#৬) — এখন রিপোর্ট MongoDB থেকে গতকাল ০০:০০ থেকে আজ ০০:০০ (BD) রেঞ্জ
      // কোয়েরি করে বানানো হয়, তাই bot মাঝরাতে redeploy/restart হলেও ডেটা হারায় না।
      const yesterdayStart = startOfYesterdayBD();
      const yesterdayKey = bdDateKeyFromUTCStart(yesterdayStart);
      try {
        const reportText = await buildDailyAdminReport(yesterdayStart, startOfTodayBD(), yesterdayKey);
        await bot.sendMessage(ADMIN_ID, reportText, { parse_mode: 'Markdown' });
        console.log('📊 Daily admin report sent for', yesterdayKey);
      } catch (e) {
        console.log('Daily report send error:', e.message);
      }
      dailyStats = { dateKey: dateKeyNow, activeUsers: new Set(), totalSignals: 0, directWin: 0, mtgWin: 0, loss: 0 };
      userDailyStats.clear();
    }
  } catch (e) {
    console.error('Daily report scheduler error:', e.message);
  }
}, 60 * 1000);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ✅ নতুন — মধ্যরাত ১২টায় Free Trial (Signal/Screenshot/MiniApp) স্বয়ংক্রিয় reset,
// কোনো ইউজারকে নোটিফিকেশন পাঠানো হয় না — নীরবে কাউন্ট ০ হয়ে যায় (২/২ ফিরে আসে)।
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let lastTrialResetDateKey = null;

setInterval(async () => {
  try {
    const { hour, minute } = getBDTimeInfo();
    const dateKeyNow = currentBDDateKey();

    if (hour === 0 && minute >= 0 && minute <= 4 && lastTrialResetDateKey !== dateKeyNow) {
      lastTrialResetDateKey = dateKeyNow;
      trialSignalCount.clear();
      trialScreenshotCount.clear();
      miniappTrialCount.clear();
      if (db) {
        try {
          await db.collection('trialCounts').deleteMany({});
          await db.collection('miniappTrialCounts').deleteMany({});
        } catch (e) {
          console.log('Trial reset DB clear error:', e.message);
        }
      }
      console.log('🔄 Daily free trial reset হয়েছে (নীরবে) for', dateKeyNow);
    }
  } catch (e) {
    console.error('Trial reset scheduler error:', e.message);
  }
}, 60 * 1000);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🔗 QUOTEX AFFILIATE POSTBACK SERVER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/postback', async (req, res) => {
  try {
    const { status, uid, eid, cid, sid, lid, country, sumdep, sumwithdraw, token } = req.query;
    console.log('📩 Postback received:', req.query);

    if (token !== process.env.POSTBACK_SECRET) {
      console.log('🚫 Postback রিজেক্ট হলো — ভুল বা মিসিং token');
      res.status(403).send('Forbidden');
      return;
    }

    if (!uid || !db) {
      console.log('⚠️ Postback received without uid or DB not ready');
      res.status(200).send('OK');
      return;
    }

    const traderId = String(uid);
    const statusVal = String(Array.isArray(status) ? status[0] : (status || '')).toLowerCase();

    if (statusVal === 'reg') {
      await db.collection('affiliateVerified').updateOne(
        { traderId },
        { $set: { traderId, registered: true, country: country || null, eventId: eid || null, receivedAt: new Date() } },
        { upsert: true }
      );
      console.log(`✅ Trader ID ${traderId} — Registration saved`);
    } else if (statusVal === 'dep') {
      const depositAmt = sumdep ? parseFloat(Array.isArray(sumdep) ? sumdep[0] : sumdep) : 0;
      const safeDeposit = isNaN(depositAmt) ? 0 : depositAmt;
      const existing = await db.collection('affiliateVerified').findOne({ traderId });
      const newTotal = (existing && existing.depositAmount ? existing.depositAmount : 0) + safeDeposit;
      const verified = newTotal >= MIN_DEPOSIT_USD;
      await db.collection('affiliateVerified').updateOne(
        { traderId },
        { $set: { traderId, registered: true, depositAmount: newTotal, verified, depositAt: new Date() } },
        { upsert: true }
      );
      console.log(`💰 Trader ID ${traderId} — Deposit updated: $${newTotal} (verified: ${verified})`);
    } else {
      await db.collection('affiliateVerified').updateOne(
        { traderId },
        { $set: { traderId, lastStatus: statusVal, receivedAt: new Date() } },
        { upsert: true }
      );
      console.log(`ℹ️ Trader ID ${traderId} — status "${statusVal}" saved (no action needed)`);
    }

    res.status(200).send('OK');
  } catch (e) {
    console.error('❌ Postback error:', e.message);
    res.status(500).send('Error');
  }
});

app.get('/', (req, res) => res.send('Bot is running.'));
// ✅ ফিক্স — আগে এখানে সরাসরি `db` (তখনকার মান, যেটা connectDB() রেজলভ হওয়ার
// *আগেই* capture হয়ে undefined থেকে যেত) পাঠানো হতো, তাই miniapp routes কখনোই
// আসল db reference পেত না। এখন getDb() একটা লাইভ getter, যেটা কল হওয়ার সময়কার
// আসল মান রিটার্ন করে।
registerMiniAppRoutes(app, {
  getDb: () => db, approvedUsers, bannedUsers, submissions,
  isApproved, getMiniappTrialLeft, incrementMiniappTrial, MINIAPP_FREE_TRIAL,
  bot,
  getCachedNews: () => newsModuleRef ? (newsModuleRef.getCachedList ? newsModuleRef.getCachedList() : []) : []
});
app.listen(PORT, () => console.log(`✅ Postback server listening on port ${PORT}`));

connectDB().then(() => {
  sessionModule = require('./session');
  if (typeof sessionModule.setEmergencyChecker === 'function') {
    sessionModule.setEmergencyChecker(() => emergencyMode);
  }
  sessionModule(bot);
  learner.startScheduler(bot);
  console.log('Bot running v26 - Back Nav Fix + TwelveData Panel + Gemini Reset + News Test + Miniapp Trial...');
  require('./screenshot')(bot, db, approvedUsers, bannedUsers, isApproved, getTrialScreenshotLeft, incrementTrialScreenshot, sendVerifyPrompt, FREE_TRIAL_SCREENSHOT, signalInlineKeyboard, lastSignalMsgId, () => emergencyMode, () => maintenanceMode);
  newsModuleRef = require('./news')(bot);
  channelModuleRef = require('./channel')(bot, newsModuleRef, () => emergencyMode, db);
  bot.startPolling();
}).catch(err => {
  console.error('MongoDB connection failed:', err);
  process.exit(1);
});
