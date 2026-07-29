const analysisEngine = require('./analysis-engine');
const twelveData = require('./twelvedata');

const activeMiniappSession = new Map(); // userId -> sessionExpiresAtMs
const SESSION_DURATION_MS = 6 * 60 * 1000; // scan+reveal+৫মিনিট seeking window কভার করার জন্য

function addScanRoute(app, deps) {
  const { getDb, approvedUsers, bannedUsers, validateInitData, isApproved, getMiniappTrialLeft, incrementMiniappTrial, MINIAPP_FREE_TRIAL } = deps;
  const ADMIN_ID = 5724602667;

  function resolveUser(req) {
    const { initData } = req.body;
    if (!initData) return null;
    const tgUser = validateInitData(initData, process.env.BOT_TOKEN);
    if (!tgUser) return null;
    if (bannedUsers.has(tgUser.id)) return null;
    return tgUser;
  }

  function userIsApproved(userId) {
    if (userId === ADMIN_ID) return true;
    return typeof isApproved === 'function' ? isApproved(userId) : approvedUsers.has(userId);
  }

  function hasActiveSession(userId) {
    return (activeMiniappSession.get(userId) || 0) > Date.now();
  }

  function checkAuth(req) {
    const tgUser = resolveUser(req);
    if (!tgUser) return null;
    if (userIsApproved(tgUser.id) || hasActiveSession(tgUser.id)) return tgUser;
    return null;
  }

  // ✅ নতুন — Scan Market বাটনে ক্লিক করলে এটা কল হয় (Trial consume + Session চালু)
  app.post('/miniapp/start-trial', async (req, res) => {
    try {
      const tgUser = resolveUser(req);
      if (!tgUser) return res.status(401).json({ ok: false, reason: 'UNAUTHORIZED' });

      if (!analysisEngine.isRealMarketOpen()) {
        return res.status(409).json({ ok: false, reason: 'MARKET_CLOSED' });
      }

      const userId = tgUser.id;
      if (userIsApproved(userId)) {
        activeMiniappSession.set(userId, Date.now() + SESSION_DURATION_MS);
        return res.json({ ok: true, approved: true, trialLeft: null, trialTotal: null });
      }

      const trialLeft = getMiniappTrialLeft ? getMiniappTrialLeft(userId) : 0;
      if (trialLeft <= 0) return res.status(403).json({ ok: false, reason: 'TRIAL_EXHAUSTED' });

      if (incrementMiniappTrial) await incrementMiniappTrial(userId);
      activeMiniappSession.set(userId, Date.now() + SESSION_DURATION_MS);

      return res.json({ ok: true, approved: false, trialLeft: trialLeft - 1, trialTotal: MINIAPP_FREE_TRIAL || 0 });
    } catch (e) {
      console.error('miniapp /start-trial error:', e.message);
      return res.status(500).json({ ok: false, reason: 'SERVER_ERROR' });
    }
  });

  app.post('/miniapp/scan', async (req, res) => {
    try {
      const { symbol } = req.body;
      const tgUser = checkAuth(req);
      if (!tgUser) return res.status(401).json({ signal: false, error: 'unauthorized' });
      if (!symbol) return res.status(400).json({ signal: false, error: 'symbol missing' });

      const cleanSymbol = String(symbol).replace(' OTC', '');
      const result = await analysisEngine.analyze(cleanSymbol);

      if (result.signal) {
        const now = new Date();
        const entryDate = new Date(Math.floor((now.getTime() + 60000) / 60000) * 60000);
        const closeDate = new Date(entryDate.getTime() + 60000);
        const bdEntry = new Date(entryDate.getTime() + 6 * 60 * 60 * 1000);
        const bdClose = new Date(closeDate.getTime() + 6 * 60 * 60 * 1000);
        const fmt = (d) => String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
        result.entryTime = fmt(bdEntry);
        result.closeTime = fmt(bdClose);
        result.entryEpochMs = entryDate.getTime();
        result.closeEpochMs = closeDate.getTime();

        // ✅ নতুন — Mini app-এর মাধ্যমে নেওয়া প্রতিটা সিগন্যাল lifetime counter হিসেবে
        // MongoDB-তে persist হচ্ছে (User Profile-এ "📠 Mini app" count দেখানোর জন্য)
        const dbLive = typeof getDb === 'function' ? getDb() : null;
        if (dbLive) {
          dbLive.collection('userStats')
            .updateOne({ userId: tgUser.id }, { $inc: { miniappScans: 1 } }, { upsert: true })
            .catch(e => console.log('miniapp scan count persist error:', e.message));
        }
      }

      return res.json(result);
    } catch (e) {
      console.error('miniapp /scan error:', e.message);
      return res.status(500).json({ signal: false, error: 'analysis failed' });
    }
  });

  app.post('/miniapp/result', async (req, res) => {
    try {
      const { symbol, direction, entryEpochMs } = req.body;
      const tgUser = checkAuth(req);
      if (!tgUser) return res.status(401).json({ status: 'error', error: 'unauthorized' });
      if (!symbol || !direction || !entryEpochMs) return res.status(400).json({ status: 'error', error: 'missing params' });

      const cleanSymbol = String(symbol).replace(' OTC', '');
      const entryDate = new Date(entryEpochMs);
      const pad = (n) => String(n).padStart(2, '0');
      const targetDatetime = `${entryDate.getUTCFullYear()}-${pad(entryDate.getUTCMonth() + 1)}-${pad(entryDate.getUTCDate())} ${pad(entryDate.getUTCHours())}:${pad(entryDate.getUTCMinutes())}:00`;

      const data = await twelveData.getTimeSeries(cleanSymbol, '1min', 10);
      if (!data.values) return res.json({ status: 'pending' });

      const match = data.values.find((v) => v.datetime === targetDatetime);
      if (!match) return res.json({ status: 'pending' });

      const open = parseFloat(match.open);
      const close = parseFloat(match.close);
      const isWin = direction === 'UP⏫' ? close > open : close < open;

      return res.json({ status: 'done', result: isWin ? 'WIN' : 'LOSS', open, close });
    } catch (e) {
      console.error('miniapp /result error:', e.message);
      return res.json({ status: 'pending' });
    }
  });
}

module.exports = { addScanRoute };
