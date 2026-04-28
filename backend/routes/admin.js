const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../lib/db');
const {
  authRequired, adminOnly,
  signImpersonationToken, recordSession, setAuthCookie,
} = require('../middleware/auth');
const { logFromReq } = require('../lib/audit');
const workerControl = require('../lib/workerControl');

const router = express.Router();
router.use(authRequired, adminOnly);

// Bot workers run in a separate PM2 process. Proxy live status/actions to that
// process so the API stays responsive and the UI sees the real bot state.
const BOT_IDS = ['ims', 'msi', 'numpanel', 'seven1tel', 'iprn-sms', 'iprn-sms-v2'];
const BOT_SETTING_KEY = {
  msi: 'msi_enabled',
  numpanel: 'numpanel_enabled',
  seven1tel: 'seven1tel_enabled',
  'iprn-sms': 'iprn_sms_enabled',
  'iprn-sms-v2': 'iprn_sms_v2_enabled',
};
function enableBotSetting(botId) {
  const key = BOT_SETTING_KEY[botId];
  if (!key) return;
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, 'true', strftime('%s','now'))
    ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = strftime('%s','now')
  `).run(key);
}
for (const botId of BOT_IDS) {
  router.get(`/${botId}-status`, async (_req, res, next) => {
    try { res.json(await workerControl.request(`/${botId}-status`)); }
    catch (e) { res.status(503).json({ error: e.message || 'Worker process unavailable' }); }
  });
  for (const action of ['restart', 'start', 'stop', 'scrape-now', 'sync-live']) {
    router.post(`/${botId}-${action}`, async (req, res, next) => {
      try {
        if (action === 'start') enableBotSetting(botId);
        const out = await workerControl.request(`/${botId}-${action}`, { method: 'POST' });
        logFromReq(req, `${botId.replace(/-/g, '_')}_${action.replace(/-/g, '_')}`, { meta: out });
        res.json(out);
      } catch (e) { res.status(503).json({ error: e.message || 'Worker process unavailable' }); }
    });
  }
}
router.post('/ims-scrape-numbers', async (req, res) => {
  try { const out = await workerControl.request('/ims-scrape-numbers', { method: 'POST' }); logFromReq(req, 'ims_scrape_numbers_start', { meta: out }); res.json(out); }
  catch (e) { res.status(503).json({ error: e.message || 'Worker process unavailable' }); }
});
router.get('/ims-numbers-job', async (_req, res) => {
  try { res.json(await workerControl.request('/ims-numbers-job')); }
  catch (e) { res.status(503).json({ error: e.message || 'Worker process unavailable' }); }
});
router.get('/autopool', async (_req, res) => {
  try { res.json(await workerControl.request('/autopool')); }
  catch (e) { res.status(503).json({ error: e.message || 'Worker process unavailable' }); }
});
router.get('/autopool/:botId', async (req, res) => {
  try { res.json(await workerControl.request(`/autopool/${encodeURIComponent(req.params.botId)}`)); }
  catch (e) { res.status(e.status || 503).json({ error: e.message || 'Worker process unavailable' }); }
});
router.put('/autopool/:botId', async (req, res) => {
  try { const out = await workerControl.request(`/autopool/${encodeURIComponent(req.params.botId)}`, { method: 'PUT', body: req.body || {} }); logFromReq(req, 'autopool_config_updated', { meta: { botId: req.params.botId, ...out.config } }); res.json(out); }
  catch (e) { res.status(e.status || 503).json({ error: e.message || 'Worker process unavailable' }); }
});
router.post('/autopool/:botId/run', async (req, res) => {
  try { const out = await workerControl.request(`/autopool/${encodeURIComponent(req.params.botId)}/run`, { method: 'POST' }); logFromReq(req, 'autopool_run_now', { meta: { botId: req.params.botId, result: out.result } }); res.json(out); }
  catch (e) { res.status(e.status || 503).json({ error: e.message || 'Worker process unavailable' }); }
});

// POST /api/admin/login-as/:id — admin starts impersonation
router.post('/login-as/:id', (req, res) => {
  const id = +req.params.id;
  const target = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'agent'").get(id);
  if (!target) return res.status(404).json({ error: 'Agent not found' });
  if (target.status !== 'active') return res.status(403).json({ error: 'Agent suspended' });

  const token = signImpersonationToken(target, req.user);
  recordSession(target.id, token, req);
  setAuthCookie(res, token);

  logFromReq(req, 'impersonation_start', {
    targetType: 'user', targetId: target.id, meta: { username: target.username },
  });

  // NOTE: Agent must NOT be notified about impersonation (silent admin access).
  // Audit log above (`impersonation_start`) is the source of truth — admin-only visibility.

  const { password_hash, ...safe } = target;
  res.json({ token, user: safe, impersonator: { id: req.user.id, username: req.user.username } });
});

// GET /api/admin/impersonations — history of admin login-as events
router.get('/impersonations', (req, res) => {
  const limit = Math.min(+req.query.limit || 200, 500);
  const rows = db.prepare(`
    SELECT a.id, a.created_at, a.action, a.user_id AS admin_id,
           a.target_id AS agent_id, a.ip, a.meta,
           ua.username AS admin_username,
           ut.username AS agent_username
    FROM audit_logs a
    LEFT JOIN users ua ON ua.id = a.user_id
    LEFT JOIN users ut ON ut.id = a.target_id
    WHERE a.action IN ('impersonation_start', 'impersonation_end')
    ORDER BY a.created_at DESC
    LIMIT ?
  `).all(limit);
  res.json({ impersonations: rows });
});

// GET /api/admin/stats — dashboard KPIs
router.get('/stats', (req, res) => {
  const todayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
  const totalAgents = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'agent'").get().c;
  const activeAgents = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'agent' AND status = 'active'").get().c;
  const totalAlloc = db.prepare("SELECT COUNT(*) c FROM allocations").get().c;
  const activeAlloc = db.prepare("SELECT COUNT(*) c FROM allocations WHERE status = 'active'").get().c;
  const totalOtp = db.prepare("SELECT COUNT(*) c FROM cdr WHERE status = 'billed'").get().c;
  const todayOtp = db.prepare("SELECT COUNT(*) c FROM cdr WHERE status = 'billed' AND created_at >= ?").get(todayStart).c;
  const todayRevenue = db.prepare("SELECT COALESCE(SUM(price_bdt),0) s FROM cdr WHERE status = 'billed' AND created_at >= ?").get(todayStart).s;
  const totalRevenue = db.prepare("SELECT COALESCE(SUM(price_bdt),0) s FROM cdr WHERE status = 'billed'").get().s;
  // Total commission credited to agents today (from successful OTPs)
  const todayCommission = db.prepare(
    "SELECT COALESCE(SUM(amount_bdt),0) s FROM payments WHERE type = 'credit' AND created_at >= ?"
  ).get(todayStart).s;
  const totalCommission = db.prepare(
    "SELECT COALESCE(SUM(amount_bdt),0) s FROM payments WHERE type = 'credit'"
  ).get().s;
  const pendingWithdrawals = db.prepare("SELECT COUNT(*) c FROM withdrawals WHERE status = 'pending'").get().c;

  // 24h OTP success/expired stats — measured against allocations (not CDR) so
  // expired numbers are counted. delivered = status='received', expired = 'expired'.
  const since24h = Math.floor(Date.now() / 1000) - 86400;
  const delivered24h = db.prepare(
    "SELECT COUNT(*) c FROM allocations WHERE status='received' AND allocated_at >= ?"
  ).get(since24h).c;
  const expired24h = db.prepare(
    "SELECT COUNT(*) c FROM allocations WHERE status='expired' AND allocated_at >= ?"
  ).get(since24h).c;
  const released24h = db.prepare(
    "SELECT COUNT(*) c FROM allocations WHERE status='released' AND allocated_at >= ?"
  ).get(since24h).c;
  const total24h = delivered24h + expired24h + released24h;
  const successRate24h = total24h > 0 ? +((delivered24h / total24h) * 100).toFixed(1) : 0;

  res.json({
    totalAgents, activeAgents, totalAlloc, activeAlloc,
    totalOtp, todayOtp, todayRevenue, totalRevenue,
    todayCommission, totalCommission, pendingWithdrawals,
    delivered24h, expired24h, released24h, total24h, successRate24h,
  });
});

// GET /api/admin/system-health — consolidated dashboard widget
//   backend uptime, memory, DB size on disk, last DB backup file (if any),
//   IMS bot status snapshot (running/loggedIn/poolSize/lastScrape),
//   AccHub OTP poller heartbeat, pending withdrawals count.
router.get('/system-health', (req, res) => {
  const fs = require('fs');
  const path = require('path');

  // --- Process / runtime ---
  const mem = process.memoryUsage();
  const uptime_sec = Math.floor(process.uptime());

  // --- DB file size on disk (best-effort) ---
  let db_size_bytes = 0, db_path = process.env.DB_PATH || './data/nexus.db';
  try {
    const resolved = path.isAbsolute(db_path) ? db_path : path.resolve(process.cwd(), db_path);
    db_size_bytes = fs.statSync(resolved).size;
  } catch (_) { /* ignore */ }

  // --- Last DB backup (look in /opt/nexus/backups or BACKUP_DIR) ---
  let last_backup = null;
  const backupDir = process.env.BACKUP_DIR || '/opt/nexus/backups';
  try {
    if (fs.existsSync(backupDir)) {
      const files = fs.readdirSync(backupDir)
        .filter((f) => /^nexus-.*\.db(\.gz)?$/.test(f))
        .map((f) => {
          const st = fs.statSync(path.join(backupDir, f));
          return { name: f, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) };
        })
        .sort((a, b) => b.mtime - a.mtime);
      if (files[0]) last_backup = files[0];
    }
  } catch (_) { /* ignore */ }

  // --- IMS bot snapshot ---
  let ims = null;
  try { ims = require('../workers/imsBot').getStatus?.() || null; } catch (_) {}

  // --- AccHub poller heartbeat ---
  let acchub = null;
  try { acchub = require('../workers/otpPoller').getStatus?.() || null; } catch (_) {}

  // --- Counts ---
  const pendingWithdrawals = db.prepare("SELECT COUNT(*) c FROM withdrawals WHERE status='pending'").get().c;
  const activeSessions = db.prepare("SELECT COUNT(*) c FROM sessions WHERE expires_at > strftime('%s','now')").get().c;
  const poolSize = db.prepare("SELECT COUNT(*) c FROM allocations WHERE provider='ims' AND status='pool'").get().c;

  res.json({
    server: {
      uptime_sec,
      node_version: process.version,
      env: process.env.NODE_ENV || 'development',
      memory_mb: {
        rss: +(mem.rss / 1048576).toFixed(1),
        heap_used: +(mem.heapUsed / 1048576).toFixed(1),
        heap_total: +(mem.heapTotal / 1048576).toFixed(1),
      },
    },
    database: {
      size_bytes: db_size_bytes,
      size_mb: +(db_size_bytes / 1048576).toFixed(2),
      path: db_path,
      last_backup,           // { name, size, mtime } or null
      backup_dir: backupDir,
    },
    ims_bot: ims ? {
      enabled: !!ims.enabled,
      running: !!ims.running,
      logged_in: !!ims.loggedIn,
      pool_size: ims.poolSize ?? poolSize,
      active_assigned: ims.activeAssigned ?? 0,
      last_scrape_at: ims.lastScrapeAt ?? null,
      last_scrape_ok: !!ims.lastScrapeOk,
      interval_sec: ims.intervalSec ?? null,
      otp_interval_sec: ims.otpIntervalSec ?? null,
      consec_fail: ims.consecFail ?? 0,
      last_error: ims.lastError ?? null,
    } : { enabled: false, running: false, pool_size: poolSize },
    acchub_poller: acchub || null,
    counts: {
      pending_withdrawals: pendingWithdrawals,
      active_sessions: activeSessions,
      ims_pool_size: poolSize,
    },
  });
});

// GET /api/admin/leaderboard
router.get('/leaderboard', (req, res) => {
  const leaderboard = db.prepare(`
    SELECT u.id, u.username, u.otp_count,
      (SELECT COUNT(*) FROM allocations a WHERE a.user_id = u.id) AS numbers_used,
      (SELECT COALESCE(SUM(price_bdt),0) FROM cdr c WHERE c.user_id = u.id AND c.status='billed') AS earnings_bdt
    FROM users u
    WHERE u.role = 'agent' AND u.username != '__ims_pool__'
    ORDER BY u.otp_count DESC LIMIT 20
  `).all();
  res.json({ leaderboard });
});

// GET /api/admin/agents — includes pending, active, suspended (excludes system pool user)
router.get('/agents', (req, res) => {
  const agents = db.prepare(`
    SELECT id, username, role, full_name, phone, telegram, balance, otp_count,
           daily_limit, per_request_limit, status, created_at
    FROM users WHERE role = 'agent' AND username != '__ims_pool__'
    ORDER BY
      CASE status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
      created_at DESC
  `).all();
  res.json({ agents });
});

// POST /api/admin/agents/:id/approve — approve a pending agent
router.post('/agents/:id/approve', (req, res) => {
  const id = +req.params.id;
  const u = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'agent'").get(id);
  if (!u) return res.status(404).json({ error: 'Agent not found' });
  if (u.status !== 'pending') return res.status(400).json({ error: 'Agent is not pending' });

  db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(id);
  // Notify the agent
  db.prepare(`
    INSERT INTO notifications (user_id, title, message, type)
    VALUES (?, 'Account approved', 'Your account has been approved by an admin. You can now log in.', 'success')
  `).run(id);
  logFromReq(req, 'agent_approved', { targetType: 'user', targetId: id, meta: { username: u.username } });
  res.json({ ok: true });
});

// POST /api/admin/agents/:id/reject — reject (delete) a pending agent
router.post('/agents/:id/reject', (req, res) => {
  const id = +req.params.id;
  const u = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'agent' AND status = 'pending'").get(id);
  if (!u) return res.status(404).json({ error: 'Pending agent not found' });
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
  logFromReq(req, 'agent_rejected', { targetType: 'user', targetId: id, meta: { username: u.username } });
  res.json({ ok: true });
});

// POST /api/admin/agents
router.post('/agents', (req, res) => {
  const { username, password, full_name, phone, telegram, daily_limit = 100, per_request_limit = 5, status = 'active' } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: 'Username already taken' });

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare(`
    INSERT INTO users (username, password_hash, role, full_name, phone, telegram, daily_limit, per_request_limit, status)
    VALUES (?, ?, 'agent', ?, ?, ?, ?, ?, ?)
  `).run(username, hash, full_name || null, phone || null, telegram || null, daily_limit, per_request_limit, status);

  logFromReq(req, 'agent_created', { targetType: 'user', targetId: result.lastInsertRowid, meta: { username } });
  const agent = db.prepare('SELECT id, username, role, full_name, balance, status FROM users WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ agent });
});

// PATCH /api/admin/agents/:id
router.patch('/agents/:id', (req, res) => {
  const id = +req.params.id;
  const allowed = ['full_name', 'phone', 'telegram', 'daily_limit', 'per_request_limit', 'status'];
  const sets = [], vals = [];
  for (const k of allowed) {
    if (k in req.body) { sets.push(`${k} = ?`); vals.push(req.body[k]); }
  }
  if (req.body.password) {
    sets.push('password_hash = ?');
    vals.push(bcrypt.hashSync(req.body.password, 10));
  }
  if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
  vals.push(id);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ? AND role = 'agent'`).run(...vals);

  logFromReq(req, 'agent_updated', { targetType: 'user', targetId: id, meta: req.body });
  res.json({ ok: true });
});

// DELETE /api/admin/agents/:id
router.delete('/agents/:id', (req, res) => {
  const id = +req.params.id;
  db.prepare("DELETE FROM users WHERE id = ? AND role = 'agent'").run(id);
  logFromReq(req, 'agent_deleted', { targetType: 'user', targetId: id });
  res.json({ ok: true });
});

// GET /api/admin/allocations
router.get('/allocations', (req, res) => {
  const allocations = db.prepare(`
    SELECT a.*, u.username FROM allocations a
    LEFT JOIN users u ON u.id = a.user_id
    ORDER BY a.allocated_at DESC LIMIT 500
  `).all();
  res.json({ allocations });
});

// GET /api/admin/pool-inspector — debug view of the unified-pool aggregation.
// For each Country → Range bucket the agents see, list every bot contributing
// to it (with its individual count) and the inferred country name. This is
// the admin's "ground truth" for diagnosing odd allocations or missing
// country labels.
router.get('/pool-inspector', async (req, res) => {
  try {
    const providers = require('../providers');
    const { bestCountryCode, countryName: cnFromCC } = require('../lib/countryInfer');
    const POOL_LABELS = {
      ims: 'Server B', msi: 'Server C', numpanel: 'Server D',
      iprn: 'Server E', iprn_sms: 'Server F', seven1tel: 'Server G',
      iprn_sms_v2: 'Server F2',
    };
    const isEnabled = (id) => {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(`${id}_enabled`);
      const raw = row?.value ?? process.env[`${id.toUpperCase()}_ENABLED`] ?? 'false';
      return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
    };
    // country_code -> { country_code, country_name, total, ranges: Map<rangeName, {range, total, bots: [{provider,label,count}]}> }
    const byCountry = new Map();
    for (const pid of Object.keys(POOL_LABELS)) {
      if (!isEnabled(pid)) continue;
      let p; try { p = providers.get(pid); } catch (_) { continue; }
      let ranges = []; try { ranges = await p.listRanges(); } catch (_) { continue; }
      for (const r of ranges || []) {
        if (!r || !r.name || !r.count) continue;
        let cc = null;
        try {
          const row = db.prepare(
            "SELECT country_code FROM allocations WHERE provider=? AND status='pool' AND COALESCE(operator,'Unknown')=? AND country_code IS NOT NULL LIMIT 1"
          ).get(pid, r.name);
          cc = row?.country_code || null;
        } catch (_) {}
        const inferred = !cc;
        if (!cc) cc = bestCountryCode(null, r.name);
        const ccKey = cc || 'ZZ';
        let cn = null;
        if (cc) {
          try {
            const row = db.prepare(
              "SELECT country_name FROM rates WHERE provider=? AND country_code=? AND country_name IS NOT NULL LIMIT 1"
            ).get(pid, cc);
            cn = row?.country_name || null;
          } catch (_) {}
          if (!cn) cn = cnFromCC(cc);
        }
        if (!byCountry.has(ccKey)) {
          byCountry.set(ccKey, {
            country_code: ccKey,
            country_name: cn || (ccKey === 'ZZ' ? 'Unknown' : ccKey),
            inferred,
            total: 0,
            ranges: new Map(),
          });
        }
        const cBucket = byCountry.get(ccKey);
        if (cn && !cBucket.country_name_locked) cBucket.country_name = cn;
        cBucket.total += r.count;
        if (!cBucket.ranges.has(r.name)) {
          cBucket.ranges.set(r.name, { range: r.name, total: 0, bots: [] });
        }
        const rBucket = cBucket.ranges.get(r.name);
        rBucket.total += r.count;
        rBucket.bots.push({ provider: pid, label: POOL_LABELS[pid], count: r.count });
      }
    }
    const countries = Array.from(byCountry.values())
      .map((c) => ({
        country_code: c.country_code,
        country_name: c.country_name,
        inferred: c.inferred,
        total: c.total,
        ranges: Array.from(c.ranges.values()).sort((a, b) => b.total - a.total),
      }))
      .sort((a, b) => b.total - a.total);
    res.json({ countries });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/commission-trend — daily commission credited to agents
router.get('/commission-trend', (req, res) => {
  const days = Math.min(Math.max(+req.query.days || 14, 1), 60);
  const now = new Date();
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const start = Math.floor(d.getTime() / 1000);
    const end = start + 86400;
    const row = db.prepare(
      "SELECT COALESCE(SUM(amount_bdt),0) s, COUNT(*) c FROM payments WHERE type = 'credit' AND created_at >= ? AND created_at < ?"
    ).get(start, end);
    series.push({
      label: d.toISOString().slice(5, 10),
      value: Math.round(row.s * 100) / 100,
      count: row.c,
    });
  }
  res.json({ series });
});

// GET /api/admin/ims-status — live IMS bot status
router.get('/ims-status', (req, res) => {
  try {
    const { getStatus } = require('../workers/imsBot');
    res.json({ status: getStatus() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/ims-restart — recycle the headless browser session
router.post('/ims-restart', async (req, res) => {
  try {
    const { restart } = require('../workers/imsBot');
    await restart();
    logFromReq(req, 'ims_bot_restart');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/ims-start — start bot (e.g., after manual stop)
router.post('/ims-start', async (req, res) => {
  try {
    const bot = require('../workers/imsBot');
    bot.start();
    bot.logEvent && bot.logEvent('success', 'Bot started by admin');
    logFromReq(req, 'ims_bot_start');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/ims-stop — stop bot (when IMS has no numbers, save resources)
router.post('/ims-stop', async (req, res) => {
  try {
    const bot = require('../workers/imsBot');
    await bot.stop();
    bot.logEvent && bot.logEvent('warn', 'Bot stopped by admin');
    logFromReq(req, 'ims_bot_stop');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/ims-scrape-now — trigger an immediate single scrape cycle
router.post('/ims-scrape-now', async (req, res) => {
  try {
    const { scrapeNow } = require('../workers/imsBot');
    const result = await scrapeNow();
    logFromReq(req, 'ims_scrape_now', { meta: result });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/ims-sync-live — reconcile pool with IMS panel reality
// Adds numbers IMS has, removes pool numbers IMS no longer shows.
// Active/received/expired allocations are NEVER touched.
router.post('/ims-sync-live', async (req, res) => {
  try {
    const { syncLive } = require('../workers/imsBot');
    const result = await syncLive();
    logFromReq(req, 'ims_sync_live', { meta: result });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/ims-scrape-numbers — start a BACKGROUND numbers/ranges scrape.
// Returns immediately with a job ID. Frontend polls /ims-numbers-job for progress.
router.post('/ims-scrape-numbers', (req, res) => {
  try {
    const { startNumbersScrapeBackground } = require('../workers/imsBot');
    const result = startNumbersScrapeBackground();
    logFromReq(req, 'ims_scrape_numbers_start', { meta: result });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/ims-numbers-job — poll status of the background numbers scrape.
router.get('/ims-numbers-job', (req, res) => {
  try {
    const { getNumbersJobStatus } = require('../workers/imsBot');
    res.json(getNumbersJobStatus());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/ims-pool-breakdown — pool size grouped by range (operator)
router.get('/ims-pool-breakdown', (req, res) => {
  const ranges = db.prepare(`
    SELECT
      COALESCE(a.operator, 'Unknown') AS name,
      COUNT(*) AS count,
      MAX(a.allocated_at) AS last_added,
      MIN(a.allocated_at) AS first_added,
      m.custom_name, m.tag_color, m.priority,
      m.request_override, m.notes, m.disabled, m.service_tag
    FROM allocations a
    LEFT JOIN ims_range_meta m ON m.range_prefix = COALESCE(a.operator, 'Unknown')
    WHERE a.provider = 'ims' AND a.status = 'pool'
    GROUP BY COALESCE(a.operator, 'Unknown')
    ORDER BY COALESCE(m.priority, 0) DESC, count DESC
  `).all();
  const totalActive = db.prepare(`SELECT COUNT(*) c FROM allocations WHERE provider='ims' AND status='active'`).get().c;
  const totalUsed = db.prepare(`SELECT COUNT(*) c FROM allocations WHERE provider='ims' AND status='used'`).get().c;
  res.json({ ranges, totalActive, totalUsed });
});

// POST /api/admin/ims-pool-cleanup — manually purge old/invalid numbers from the pool.
// Body: { mode: 'expired' | 'older_than' | 'range' | 'all_pool', hours?: number, range?: string }
//   - expired:    delete allocations with status IN ('expired','received') older than 7 days
//   - older_than: delete pool numbers added more than `hours` hours ago (default 24h)
//   - range:      delete all POOL numbers for a given operator (e.g. "Peru Bitel TF04")
//   - all_pool:   nuke the entire IMS pool (kept-as-active rows untouched). Use with care.
router.post('/ims-pool-cleanup', (req, res) => {
  try {
    const { mode = 'older_than', hours = 24, range } = req.body || {};
    let result = { changes: 0 };
    let description = '';

    if (mode === 'expired') {
      const days = 7;
      result = db.prepare(`
        DELETE FROM allocations
        WHERE provider = 'ims'
          AND status IN ('expired', 'received')
          AND allocated_at < strftime('%s','now') - ?
      `).run(days * 86400);
      description = `Purged ${result.changes} expired/completed allocations (>${days}d)`;
    } else if (mode === 'older_than') {
      const h = Math.max(1, +hours || 24);
      result = db.prepare(`
        DELETE FROM allocations
        WHERE provider = 'ims' AND status = 'pool'
          AND allocated_at < strftime('%s','now') - ?
      `).run(h * 3600);
      description = `Purged ${result.changes} pool numbers older than ${h}h`;
    } else if (mode === 'range') {
      if (!range || typeof range !== 'string') {
        return res.status(400).json({ error: 'range is required for mode=range' });
      }
      result = db.prepare(`
        DELETE FROM allocations
        WHERE provider = 'ims' AND status = 'pool' AND COALESCE(operator,'Unknown') = ?
      `).run(range);
      description = `Purged ${result.changes} pool numbers from range "${range}"`;
    } else if (mode === 'all_pool') {
      result = db.prepare(`
        DELETE FROM allocations
        WHERE provider = 'ims' AND status = 'pool'
      `).run();
      description = `Purged entire pool (${result.changes} numbers)`;
    } else {
      return res.status(400).json({ error: 'Invalid mode. Use: expired | older_than | range | all_pool' });
    }

    logFromReq(req, 'ims_pool_cleanup', { meta: { mode, hours, range, removed: result.changes } });
    try {
      const bot = require('../workers/imsBot');
      bot.logEvent && bot.logEvent('warn', description);
    } catch (_) {}

    res.json({ ok: true, removed: result.changes, description });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/ims-credentials', (req, res) => {
  const get = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value || '';
  const username = get('ims_username') || process.env.IMS_USERNAME || '';
  const password = get('ims_password') || process.env.IMS_PASSWORD || '';
  const base_url = get('ims_base_url') || process.env.IMS_BASE_URL || 'https://www.imssms.org';
  const enabled = (get('ims_enabled') || process.env.IMS_ENABLED || 'false').toString().toLowerCase() === 'true';
  const mask = (s) => s ? (s.length <= 4 ? '****' : s.slice(0,2) + '****' + s.slice(-2)) : '';
  res.json({
    enabled,
    base_url,
    username,                     // username shown plain (it's not secret)
    password_masked: mask(password),
    has_password: !!password,
    source: {
      username: get('ims_username') ? 'database' : (process.env.IMS_USERNAME ? 'env' : 'none'),
      password: get('ims_password') ? 'database' : (process.env.IMS_PASSWORD ? 'env' : 'none'),
    },
  });
});

// PUT /api/admin/ims-credentials — save credentials to settings (overrides .env on next start)
router.put('/ims-credentials', async (req, res) => {
  try {
    const { username, password, base_url, enabled } = req.body || {};
    const upsert = db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%s','now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s','now')
    `);
    if (typeof username === 'string' && username.length) upsert.run('ims_username', username.trim());
    if (typeof password === 'string' && password.length) upsert.run('ims_password', password);
    if (typeof base_url === 'string' && base_url.length) upsert.run('ims_base_url', base_url.trim().replace(/\/$/, ''));
    if (typeof enabled === 'boolean') upsert.run('ims_enabled', enabled ? 'true' : 'false');

    logFromReq(req, 'ims_credentials_updated', { meta: { username: username || '(unchanged)', enabled } });

    // Hot-restart bot so new credentials take effect immediately
    try {
      const bot = require('../workers/imsBot');
      await bot.restart();
      bot.logEvent && bot.logEvent('success', 'Credentials updated by admin — bot restarting');
    } catch (e) {
      console.warn('ims-credentials: restart failed:', e.message);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- IMS Session Cookies (bypass captcha by reusing browser session) ----
// GET /api/admin/ims-cookies — returns whether cookies are saved (never the value)
router.get('/ims-cookies', (req, res) => {
  const row = db.prepare("SELECT value, updated_at FROM settings WHERE key = 'ims_cookies'").get();
  if (!row || !row.value) return res.json({ has_cookies: false, count: 0, saved_at: null });
  let count = 0;
  try {
    const parsed = JSON.parse(row.value);
    count = Array.isArray(parsed) ? parsed.length : 0;
  } catch (_) {
    count = (row.value.match(/[^;\s][^;]*=/g) || []).length;
  }
  res.json({ has_cookies: true, count, saved_at: row.updated_at });
});

// PUT /api/admin/ims-cookies — admin pastes session cookies (JSON or "k=v; k=v" format)
router.put('/ims-cookies', async (req, res) => {
  try {
    const { cookies } = req.body || {};
    if (typeof cookies !== 'string' || !cookies.trim()) {
      return res.status(400).json({ error: 'cookies (string) required' });
    }
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES ('ims_cookies', ?, strftime('%s','now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s','now')
    `).run(cookies.trim());
    logFromReq(req, 'ims_cookies_updated', { meta: { length: cookies.length } });
    try {
      const bot = require('../workers/imsBot');
      await bot.restart();
      bot.logEvent && bot.logEvent('success', 'Session cookies updated by admin — bot restarting');
    } catch (e) {
      console.warn('ims-cookies: restart failed:', e.message);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/admin/ims-cookies — clear saved cookies (force form login next time)
router.delete('/ims-cookies', async (req, res) => {
  try {
    db.prepare("DELETE FROM settings WHERE key = 'ims_cookies'").run();
    logFromReq(req, 'ims_cookies_cleared', {});
    try {
      const bot = require('../workers/imsBot');
      await bot.restart();
    } catch (_) {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/ims-otp-interval — current fast-OTP poll interval (seconds)
router.get('/ims-otp-interval', (req, res) => {
  const dbVal = +(db.prepare("SELECT value FROM settings WHERE key = 'ims_otp_interval'").get()?.value || 0);
  const envVal = +(process.env.IMS_OTP_INTERVAL || 10);
  const effective = dbVal > 0 ? dbVal : envVal;
  res.json({
    interval_sec: effective,
    source: dbVal > 0 ? 'database' : 'env',
    options: [5, 10, 30],
    min: 3,
    max: 120,
  });
});

// PUT /api/admin/ims-otp-interval — admin sets fast-OTP poll cadence (5/10/30s typical)
router.put('/ims-otp-interval', async (req, res) => {
  try {
    const interval = +(req.body?.interval_sec);
    if (!Number.isFinite(interval) || interval < 3 || interval > 120) {
      return res.status(400).json({ error: 'interval_sec must be a number between 3 and 120' });
    }
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES ('ims_otp_interval', ?, strftime('%s','now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s','now')
    `).run(String(interval));
    logFromReq(req, 'ims_otp_interval_updated', { meta: { interval_sec: interval } });
    // Restart bot so new interval takes effect immediately
    try {
      const bot = require('../workers/imsBot');
      await bot.restart();
      bot.logEvent && bot.logEvent('success', `OTP poll interval changed to ${interval}s by admin`);
    } catch (e) { console.warn('ims-otp-interval restart:', e.message); }
    res.json({ ok: true, interval_sec: interval });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/provider-status — health for all configured providers (AccHub balance, IMS bot, etc.)
router.get('/provider-status', async (req, res) => {
  try {
    const providers = require('../providers');
    // Helper: read enabled flag from settings/env (mirrors /api/numbers/providers logic)
    const readEnabled = (id) => {
      if (id === 'acchub') return true; // acchub has no toggle (API only)
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(`${id}_enabled`);
      const dbVal = row?.value;
      const envVal = process.env[`${id.toUpperCase()}_ENABLED`];
      const raw = dbVal ?? envVal ?? 'false';
      return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
    };
    const out = [];
    for (const meta of providers.list()) {
      const p = providers.get(meta.id);
      const enabled = readEnabled(meta.id);
      const togglable = meta.id !== 'acchub';
      if (typeof p.getStatus === 'function') {
        try {
          const s = await p.getStatus();
          out.push({ ...s, enabled, togglable });
        }
        catch (e) { out.push({ id: meta.id, name: meta.name, configured: false, lastError: e.message, enabled, togglable }); }
      } else {
        out.push({ id: meta.id, name: meta.name, configured: true, lastError: null, enabled, togglable });
      }
    }
    res.json({ providers: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/admin/provider-toggle — Soft ON/OFF toggle for any provider.
// Body: { id: 'msi'|'numpanel'|'ims'|'iprn_sms'|'iprn_sms_v2'|'seven1tel', enabled: boolean }
// - flips <id>_enabled in settings (overrides .env)
// - calls bot.start() / bot.stop() so the change takes effect immediately
// - data (allocations, rates, range_meta) is preserved → "soft" disable
router.put('/provider-toggle', async (req, res) => {
  try {
    const { id, enabled } = req.body || {};
    const validIds = ['msi', 'iprn_sms', 'iprn_sms_v2', 'numpanel', 'ims', 'seven1tel'];
    if (!validIds.includes(id)) {
      return res.status(400).json({ error: `id must be one of: ${validIds.join(', ')}` });
    }
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled (boolean) required' });
    }

    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%s','now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s','now')
    `).run(`${id}_enabled`, enabled ? 'true' : 'false');

    const botFile =
      id === 'iprn_sms' ? 'iprnSmsBot' :
      id === 'iprn_sms_v2' ? 'iprnSmsBotV2' :
      id === 'msi' ? 'msiBot' :
      id === 'seven1tel' ? 'seven1telBot' :
      id === 'numpanel' ? 'numpanelBot' :
      'imsBot';
    let botMsg = '';
    try {
      const bot = require(`../workers/${botFile}`);
      if (enabled) {
        bot.start();
        botMsg = 'bot started';
      } else {
        if (typeof bot.stop === 'function') {
          await bot.stop();
          botMsg = 'bot stopped';
        } else {
          botMsg = 'bot has no stop() — will exit on next cycle';
        }
      }
      bot.logEvent && bot.logEvent(enabled ? 'success' : 'warn', `Toggled ${enabled ? 'ON' : 'OFF'} by admin`);
    } catch (e) {
      console.warn(`provider-toggle ${id}: bot ${enabled ? 'start' : 'stop'} failed:`, e.message);
      botMsg = `bot reload failed: ${e.message}`;
    }

    logFromReq(req, 'provider_toggle', { meta: { id, enabled, bot: botMsg } });
    res.json({ ok: true, id, enabled, message: botMsg });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// AccHub credentials — saved to settings, override .env
// ============================================================
const ACCHUB_DEFAULT_URL = 'https://sms.acchub.io';
const maskAcc = (s) => s ? (s.length <= 4 ? '****' : s.slice(0,2) + '****' + s.slice(-2)) : '';

router.get('/acchub-credentials', (req, res) => {
  const get = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value || '';
  const username = get('acchub_username') || process.env.ACCHUB_USERNAME || '';
  const password = get('acchub_password') || process.env.ACCHUB_PASSWORD || '';
  const base_url = get('acchub_base_url') || process.env.ACCHUB_BASE_URL || ACCHUB_DEFAULT_URL;
  res.json({
    base_url,
    username,
    password_masked: maskAcc(password),
    has_password: !!password,
    source: {
      base_url: get('acchub_base_url') ? 'database' : (process.env.ACCHUB_BASE_URL ? 'env' : 'default'),
      username: get('acchub_username') ? 'database' : (process.env.ACCHUB_USERNAME ? 'env' : 'none'),
      password: get('acchub_password') ? 'database' : (process.env.ACCHUB_PASSWORD ? 'env' : 'none'),
    },
  });
});

router.put('/acchub-credentials', async (req, res) => {
  try {
    const { username, password, base_url } = req.body || {};
    const upsert = db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%s','now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s','now')
    `);
    if (typeof username === 'string' && username.length) upsert.run('acchub_username', username.trim());
    if (typeof password === 'string' && password.length) upsert.run('acchub_password', password);
    if (typeof base_url === 'string' && base_url.length) upsert.run('acchub_base_url', base_url.trim().replace(/\/$/, ''));

    logFromReq(req, 'acchub_credentials_updated', { meta: { username: username || '(unchanged)' } });

    try {
      const acchub = require('../providers/acchub');
      acchub.resetAuth && acchub.resetAuth();
    } catch (e) { console.warn('acchub resetAuth failed:', e.message); }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/acchub-test — fresh login + balance check
router.post('/acchub-test', async (req, res) => {
  try {
    const acchub = require('../providers/acchub');
    acchub.resetAuth && acchub.resetAuth();
    const status = await acchub.getStatus();
    if (status.lastError) return res.status(400).json({ ok: false, error: status.lastError, status });
    res.json({ ok: true, status });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// =============================================================
// OTP expiry window (5-30 min) — controls how long an allocated number stays
// "active" before it's auto-expired. Used by:
//   • otpPoller cleanup cron (releases stale numbers)
//   • numbers.js /get (recent-window for upstream polling)
//   • agent UI countdown timer (read via /api/numbers/config)
// =============================================================
const {
  getOtpExpirySec, OTP_EXPIRY_MIN, OTP_EXPIRY_MAX, OTP_EXPIRY_KEY,
  getRecentOtpHours, RECENT_OTP_HOURS_KEY, RECENT_OTP_HOURS_MIN, RECENT_OTP_HOURS_MAX,
} = require('../lib/settings');

// ---- Recent-OTP window (controls how long received OTPs stay on the
//      agent's "live" list before sliding into history) ----
router.get('/recent-otp-window', (req, res) => {
  const stored = +(db.prepare('SELECT value FROM settings WHERE key = ?').get(RECENT_OTP_HOURS_KEY)?.value || 0);
  const effective = getRecentOtpHours();
  res.json({
    hours: effective,
    source: stored > 0 ? 'database' : 'default',
    min: RECENT_OTP_HOURS_MIN,
    max: RECENT_OTP_HOURS_MAX,
    options_hours: [1, 6, 12, 24, 48, 72, 168],
  });
});

router.put('/recent-otp-window', (req, res) => {
  try {
    const hours = +(req.body?.hours);
    if (!Number.isFinite(hours) || hours < RECENT_OTP_HOURS_MIN || hours > RECENT_OTP_HOURS_MAX) {
      return res.status(400).json({ error: `hours must be between ${RECENT_OTP_HOURS_MIN} and ${RECENT_OTP_HOURS_MAX}` });
    }
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%s','now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s','now')
    `).run(RECENT_OTP_HOURS_KEY, String(Math.floor(hours)));
    logFromReq(req, 'recent_otp_window_updated', { meta: { hours } });
    res.json({ ok: true, hours: Math.floor(hours) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/otp-expiry', (req, res) => {
  const stored = +(db.prepare('SELECT value FROM settings WHERE key = ?').get(OTP_EXPIRY_KEY)?.value || 0);
  const effective = getOtpExpirySec();
  res.json({
    expiry_sec: effective,
    expiry_min: Math.round(effective / 60),
    source: stored > 0 ? 'database' : 'default',
    min: OTP_EXPIRY_MIN,
    max: OTP_EXPIRY_MAX,
    options_min: [5, 8, 10, 15, 20, 30],
  });
});

router.put('/otp-expiry', (req, res) => {
  try {
    let sec = +(req.body?.expiry_sec);
    if (!Number.isFinite(sec) || sec <= 0) {
      const min = +(req.body?.expiry_min);
      if (Number.isFinite(min) && min > 0) sec = min * 60;
    }
    if (!Number.isFinite(sec) || sec < OTP_EXPIRY_MIN || sec > OTP_EXPIRY_MAX) {
      return res.status(400).json({ error: `expiry_sec must be between ${OTP_EXPIRY_MIN} and ${OTP_EXPIRY_MAX} seconds (5-30 min)` });
    }
    sec = Math.floor(sec);
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%s','now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s','now')
    `).run(OTP_EXPIRY_KEY, String(sec));
    logFromReq(req, 'otp_expiry_updated', { meta: { expiry_sec: sec } });
    res.json({ ok: true, expiry_sec: sec, expiry_min: Math.round(sec / 60) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// MSI Bot — mirrors IMS endpoints (status/start/stop/restart/scrape/sync/credentials)
// ============================================================

router.get('/msi-status', (req, res) => {
  try {
    const { getStatus } = require('../workers/msiBot');
    res.json({ status: getStatus() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/msi-restart', async (req, res) => {
  try {
    const { restart } = require('../workers/msiBot');
    await restart();
    logFromReq(req, 'msi_bot_restart');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/msi-start', async (req, res) => {
  try {
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES ('msi_enabled', 'true', strftime('%s','now'))
      ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = strftime('%s','now')
    `).run();
    const bot = require('../workers/msiBot');
    bot.start();
    const snapshot = bot.getStatus ? bot.getStatus() : null;
    if (!snapshot?.running) {
      return res.status(400).json({ error: snapshot?.lastError || 'MSI bot did not start', status: snapshot, auto_enabled: true });
    }
    bot.logEvent && bot.logEvent('success', 'Bot started by admin');
    logFromReq(req, 'msi_bot_start');
    res.json({ ok: true, status: snapshot, auto_enabled: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/msi-stop', async (req, res) => {
  try {
    const bot = require('../workers/msiBot');
    await bot.stop();
    bot.logEvent && bot.logEvent('warn', 'Bot stopped by admin');
    logFromReq(req, 'msi_bot_stop');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/msi-scrape-now', async (req, res) => {
  try {
    const { scrapeNow } = require('../workers/msiBot');
    const result = await scrapeNow();
    logFromReq(req, 'msi_scrape_now', { meta: result });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/msi-sync-live', async (req, res) => {
  try {
    const { syncLive } = require('../workers/msiBot');
    const result = await syncLive();
    logFromReq(req, 'msi_sync_live', { meta: result });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/msi-pool-breakdown', (req, res) => {
  const ranges = db.prepare(`
    SELECT
      COALESCE(a.operator, 'Unknown') AS name,
      COUNT(*) AS count,
      MAX(a.allocated_at) AS last_added,
      MIN(a.allocated_at) AS first_added,
      m.custom_name, m.tag_color, m.priority,
      m.request_override, m.notes, m.disabled, m.service_tag
    FROM allocations a
    LEFT JOIN msi_range_meta m ON m.range_prefix = COALESCE(a.operator, 'Unknown')
    WHERE a.provider = 'msi' AND a.status = 'pool'
    GROUP BY COALESCE(a.operator, 'Unknown')
    ORDER BY COALESCE(m.priority, 0) DESC, count DESC
  `).all();
  const totalActive = db.prepare(`SELECT COUNT(*) c FROM allocations WHERE provider='msi' AND status='active'`).get().c;
  const totalUsed = db.prepare(`SELECT COUNT(*) c FROM allocations WHERE provider='msi' AND status='used'`).get().c;
  res.json({ ranges, totalActive, totalUsed });
});

router.get('/msi-credentials', (req, res) => {
  const get = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value || '';
  const username = get('msi_username') || process.env.MSI_USERNAME || '';
  const password = get('msi_password') || process.env.MSI_PASSWORD || '';
  const base_url = get('msi_base_url') || process.env.MSI_BASE_URL || 'http://145.239.130.45';
  const enabled = (get('msi_enabled') || process.env.MSI_ENABLED || 'false').toString().toLowerCase() === 'true';
  const mask = (s) => s ? (s.length <= 4 ? '****' : s.slice(0,2) + '****' + s.slice(-2)) : '';
  res.json({
    enabled,
    base_url,
    username,
    password_masked: mask(password),
    has_password: !!password,
    source: {
      username: get('msi_username') ? 'database' : (process.env.MSI_USERNAME ? 'env' : 'none'),
      password: get('msi_password') ? 'database' : (process.env.MSI_PASSWORD ? 'env' : 'none'),
    },
  });
});

router.put('/msi-credentials', async (req, res) => {
  try {
    const { username, password, base_url, enabled } = req.body || {};
    const upsert = db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%s','now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s','now')
    `);
    if (typeof username === 'string' && username.length) upsert.run('msi_username', username.trim());
    if (typeof password === 'string' && password.length) upsert.run('msi_password', password);
    if (typeof base_url === 'string' && base_url.length) {
      // Normalize: keep scheme+host only. Strip /ints/login or any path the admin pasted.
      let clean = base_url.trim().replace(/\/+$/, '');
      try {
        const u = new URL(/^https?:\/\//i.test(clean) ? clean : `http://${clean}`);
        clean = `${u.protocol}//${u.host}`;
      } catch (_) {
        clean = clean.replace(/\/ints\/.*$/i, '').replace(/\/+$/, '');
      }
      if (clean) upsert.run('msi_base_url', clean);
    }
    if (typeof enabled === 'boolean') upsert.run('msi_enabled', enabled ? 'true' : 'false');
    logFromReq(req, 'msi_credentials_updated', { meta: { username: username || '(unchanged)', enabled } });
    try {
      const bot = require('../workers/msiBot');
      await bot.restart();
      bot.logEvent && bot.logEvent('success', 'Credentials updated by admin — bot restarting');
    } catch (e) { console.warn('msi-credentials: restart failed:', e.message); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- MSI OTP poll interval (mirrors IMS) ----
router.get('/msi-otp-interval', (req, res) => {
  const dbVal = +(db.prepare("SELECT value FROM settings WHERE key = 'msi_otp_interval'").get()?.value || 0);
  const envVal = +(process.env.MSI_SCRAPE_INTERVAL || 5);
  const effective = dbVal > 0 ? dbVal : envVal;
  res.json({ interval_sec: effective, source: dbVal > 0 ? 'database' : 'env', options: [3, 5, 10, 30], min: 3, max: 120 });
});

router.put('/msi-otp-interval', async (req, res) => {
  try {
    const interval = +(req.body?.interval_sec);
    if (!Number.isFinite(interval) || interval < 3 || interval > 120) {
      return res.status(400).json({ error: 'interval_sec must be a number between 3 and 120' });
    }
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES ('msi_otp_interval', ?, strftime('%s','now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s','now')
    `).run(String(interval));
    logFromReq(req, 'msi_otp_interval_updated', { meta: { interval_sec: interval } });
    try {
      const bot = require('../workers/msiBot');
      await bot.restart();
      bot.logEvent && bot.logEvent('success', `OTP poll interval changed to ${interval}s by admin`);
    } catch (e) { console.warn('msi-otp-interval restart:', e.message); }
    res.json({ ok: true, interval_sec: interval });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- MSI Session Cookies (mirrors IMS) ----
router.get('/msi-cookies', (req, res) => {
  const row = db.prepare("SELECT value, updated_at FROM settings WHERE key = 'msi_cookies'").get();
  if (!row || !row.value) return res.json({ has_cookies: false, count: 0, saved_at: null });
  let count = 0;
  try {
    const parsed = JSON.parse(row.value);
    count = Array.isArray(parsed) ? parsed.length : 0;
  } catch (_) {
    count = (row.value.match(/[^;\s][^;]*=/g) || []).length;
  }
  res.json({ has_cookies: true, count, saved_at: row.updated_at });
});

router.put('/msi-cookies', async (req, res) => {
  try {
    const { cookies } = req.body || {};
    if (typeof cookies !== 'string' || !cookies.trim()) {
      return res.status(400).json({ error: 'cookies (string) required' });
    }
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES ('msi_cookies', ?, strftime('%s','now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s','now')
    `).run(cookies.trim());
    logFromReq(req, 'msi_cookies_updated', { meta: { length: cookies.length } });
    try {
      const bot = require('../workers/msiBot');
      await bot.restart();
      bot.logEvent && bot.logEvent('success', 'Session cookies updated by admin — bot restarting');
    } catch (e) { console.warn('msi-cookies: restart failed:', e.message); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/msi-cookies', async (req, res) => {
  try {
    db.prepare("DELETE FROM settings WHERE key = 'msi_cookies'").run();
    logFromReq(req, 'msi_cookies_cleared', {});
    try {
      const bot = require('../workers/msiBot');
      await bot.restart();
    } catch (_) {}
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// NUMPANEL Bot — mirrors MSI route surface
// ============================================================

router.get('/numpanel-status', (req, res) => {
  try {
    const { getStatus } = require('../workers/numpanelBot');
    res.json({ status: getStatus() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/numpanel-restart', async (req, res) => {
  try {
    const { restart } = require('../workers/numpanelBot');
    await restart();
    logFromReq(req, 'numpanel_bot_restart');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/numpanel-start', async (req, res) => {
  try {
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES ('numpanel_enabled', '1', strftime('%s','now'))
      ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = strftime('%s','now')
    `).run();
    const bot = require('../workers/numpanelBot');
    bot.start();
    const snapshot = bot.getStatus ? bot.getStatus() : null;
    if (!snapshot?.running) {
      return res.status(400).json({ error: snapshot?.lastError || 'NumPanel bot did not start', status: snapshot, auto_enabled: true });
    }
    bot.logEvent && bot.logEvent('success', 'Bot started by admin');
    logFromReq(req, 'numpanel_bot_start');
    res.json({ ok: true, status: snapshot, auto_enabled: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/numpanel-stop', async (req, res) => {
  try {
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES ('numpanel_enabled', '0', strftime('%s','now'))
      ON CONFLICT(key) DO UPDATE SET value = '0', updated_at = strftime('%s','now')
    `).run();
    const bot = require('../workers/numpanelBot');
    await bot.stop();
    bot.logEvent && bot.logEvent('warn', 'Bot stopped by admin');
    logFromReq(req, 'numpanel_bot_stop');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/numpanel-scrape-now', async (req, res) => {
  try {
    const { scrapeNow } = require('../workers/numpanelBot');
    const result = await scrapeNow();
    logFromReq(req, 'numpanel_scrape_now', { meta: result });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/numpanel-sync-live', async (req, res) => {
  try {
    const { syncLive } = require('../workers/numpanelBot');
    const result = await syncLive();
    logFromReq(req, 'numpanel_sync_live', { meta: result });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/numpanel-pool-breakdown', (req, res) => {
  const ranges = db.prepare(`
    SELECT
      COALESCE(a.operator, 'Unknown') AS name,
      COUNT(*) AS count,
      MAX(a.allocated_at) AS last_added,
      MIN(a.allocated_at) AS first_added,
      m.custom_name, m.tag_color, m.priority,
      m.request_override, m.notes, m.disabled, m.service_tag
    FROM allocations a
    LEFT JOIN numpanel_range_meta m ON m.range_prefix = COALESCE(a.operator, 'Unknown')
    WHERE a.provider = 'numpanel' AND a.status = 'pool'
    GROUP BY COALESCE(a.operator, 'Unknown')
    ORDER BY COALESCE(m.priority, 0) DESC, count DESC
  `).all();
  const totalActive = db.prepare(`SELECT COUNT(*) c FROM allocations WHERE provider='numpanel' AND status='active'`).get().c;
  const totalUsed = db.prepare(`SELECT COUNT(*) c FROM allocations WHERE provider='numpanel' AND status='used'`).get().c;
  res.json({ ranges, totalActive, totalUsed });
});

// ---- Generic Range Metadata Routes (numpanel | ims | msi | iprn | iprn_sms) ----
const RANGE_META_TABLES = {
  numpanel: 'numpanel_range_meta',
  ims: 'ims_range_meta',
  msi: 'msi_range_meta',
  iprn_sms: 'iprn_sms_range_meta',
  iprn_sms_v2: 'iprn_sms_v2_range_meta',
  seven1tel: 'seven1tel_range_meta',
};
const VALID_SERVICE_TAGS = new Set(['facebook', 'whatsapp', 'telegram', 'instagram', 'twitter', 'tiktok', 'google', 'other', null, '']);

function rangeMetaRoutes(provider) {
  const table = RANGE_META_TABLES[provider];
  router.get(`/${provider}-range-meta`, (req, res) => {
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY priority DESC, range_prefix`).all();
    res.json({ ranges: rows });
  });
  router.put(`/${provider}-range-meta`, (req, res) => {
    const { range_prefix, custom_name, tag_color, priority, request_override, notes, disabled, service_tag } = req.body || {};
    if (!range_prefix || typeof range_prefix !== 'string') {
      return res.status(400).json({ error: 'range_prefix required' });
    }
    if (service_tag !== undefined && !VALID_SERVICE_TAGS.has(service_tag)) {
      return res.status(400).json({ error: `invalid service_tag — allowed: ${[...VALID_SERVICE_TAGS].filter(Boolean).join(', ')}` });
    }
    db.prepare(`
      INSERT INTO ${table} (range_prefix, custom_name, tag_color, priority, request_override, notes, disabled, service_tag, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
      ON CONFLICT(range_prefix) DO UPDATE SET
        custom_name      = COALESCE(excluded.custom_name, ${table}.custom_name),
        tag_color        = COALESCE(excluded.tag_color, ${table}.tag_color),
        priority         = COALESCE(excluded.priority, ${table}.priority),
        request_override = COALESCE(excluded.request_override, ${table}.request_override),
        notes            = COALESCE(excluded.notes, ${table}.notes),
        disabled         = COALESCE(excluded.disabled, ${table}.disabled),
        service_tag      = COALESCE(excluded.service_tag, ${table}.service_tag),
        updated_at       = strftime('%s','now')
    `).run(
      range_prefix.trim(),
      typeof custom_name === 'string' ? custom_name.trim() : null,
      typeof tag_color === 'string' ? tag_color.trim() : null,
      Number.isFinite(+priority) ? +priority : null,
      Number.isFinite(+request_override) ? +request_override : null,
      typeof notes === 'string' ? notes.trim() : null,
      typeof disabled === 'boolean' ? (disabled ? 1 : 0) : (disabled === 1 || disabled === 0 ? disabled : null),
      typeof service_tag === 'string' ? service_tag.trim().toLowerCase() : null,
    );
    logFromReq(req, `${provider}_range_meta_set`, { meta: req.body });
    res.json({ ok: true });
  });
  router.delete(`/${provider}-range-meta/:prefix`, (req, res) => {
    db.prepare(`DELETE FROM ${table} WHERE range_prefix = ?`).run(req.params.prefix);
    logFromReq(req, `${provider}_range_meta_delete`, { meta: { prefix: req.params.prefix } });
    res.json({ ok: true });
  });
}
rangeMetaRoutes('numpanel');
rangeMetaRoutes('ims');
rangeMetaRoutes('msi');
rangeMetaRoutes('iprn_sms');
rangeMetaRoutes('iprn_sms_v2');
rangeMetaRoutes('seven1tel');

router.get('/numpanel-credentials', (req, res) => {
  const get = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value || '';
  const username = get('numpanel_username') || process.env.NUMPANEL_USERNAME || '';
  const password = get('numpanel_password') || process.env.NUMPANEL_PASSWORD || '';
  const base_url = get('numpanel_base_url') || process.env.NUMPANEL_BASE_URL || 'http://51.89.99.105';
  const enabledRaw = (get('numpanel_enabled') || process.env.NUMPANEL_ENABLED || 'false').toString().toLowerCase();
  const enabled = ['1', 'true', 'yes', 'on'].includes(enabledRaw);
  const mask = (s) => s ? (s.length <= 4 ? '****' : s.slice(0,2) + '****' + s.slice(-2)) : '';
  res.json({
    enabled, base_url, username,
    password_masked: mask(password),
    has_password: !!password,
    source: {
      username: get('numpanel_username') ? 'database' : (process.env.NUMPANEL_USERNAME ? 'env' : 'none'),
      password: get('numpanel_password') ? 'database' : (process.env.NUMPANEL_PASSWORD ? 'env' : 'none'),
    },
  });
});

router.put('/numpanel-credentials', async (req, res) => {
  try {
    const { username, password, base_url, enabled } = req.body || {};
    const upsert = db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%s','now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s','now')
    `);
    if (typeof username === 'string' && username.length) upsert.run('numpanel_username', username.trim());
    if (typeof password === 'string' && password.length) upsert.run('numpanel_password', password);
    if (typeof base_url === 'string' && base_url.length) {
      let clean = base_url.trim().replace(/\/+$/, '');
      try {
        const u = new URL(/^https?:\/\//i.test(clean) ? clean : `http://${clean}`);
        clean = `${u.protocol}//${u.host}`;
      } catch (_) {
        clean = clean.replace(/\/NumberPanel\/.*$/i, '').replace(/\/+$/, '');
      }
      if (clean) upsert.run('numpanel_base_url', clean);
    }
    if (typeof enabled === 'boolean') upsert.run('numpanel_enabled', enabled ? '1' : '0');
    logFromReq(req, 'numpanel_credentials_updated', { meta: { username: username || '(unchanged)', enabled } });
    try {
      const bot = require('../workers/numpanelBot');
      await bot.restart();
      bot.logEvent && bot.logEvent('success', 'Credentials updated by admin — bot restarting');
    } catch (e) { console.warn('numpanel-credentials: restart failed:', e.message); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/numpanel-otp-interval', (req, res) => {
  const dbVal = +(db.prepare("SELECT value FROM settings WHERE key = 'numpanel_otp_interval'").get()?.value || 0);
  const envVal = +(process.env.NUMPANEL_SCRAPE_INTERVAL || 4);
  const effective = dbVal > 0 ? dbVal : envVal;
  res.json({ interval_sec: effective, source: dbVal > 0 ? 'database' : 'env', options: [2, 3, 5, 10], min: 2, max: 60 });
});

router.put('/numpanel-otp-interval', async (req, res) => {
  try {
    const interval = +(req.body?.interval_sec);
    if (!Number.isFinite(interval) || interval < 2 || interval > 60) {
      return res.status(400).json({ error: 'interval_sec must be a number between 2 and 60' });
    }
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES ('numpanel_otp_interval', ?, strftime('%s','now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s','now')
    `).run(String(interval));
    logFromReq(req, 'numpanel_otp_interval_updated', { meta: { interval_sec: interval } });
    try {
      const bot = require('../workers/numpanelBot');
      await bot.restart();
      bot.logEvent && bot.logEvent('success', `OTP poll interval changed to ${interval}s by admin`);
    } catch (e) { console.warn('numpanel-otp-interval restart:', e.message); }
    res.json({ ok: true, interval_sec: interval });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/numpanel-api-token', (req, res) => {
  const get = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value || '';
  const token = get('numpanel_api_token') || process.env.NUMPANEL_API_TOKEN || '';
  const api_base = get('numpanel_api_base') || process.env.NUMPANEL_API_BASE || 'http://147.135.212.197/crapi/st/viewstats';
  const mask = (s) => s ? (s.length <= 8 ? '****' : s.slice(0,4) + '****' + s.slice(-4)) : '';
  res.json({
    has_token: !!token,
    token_masked: mask(token),
    api_base,
    source: get('numpanel_api_token') ? 'database' : (process.env.NUMPANEL_API_TOKEN ? 'env' : 'none'),
  });
});

router.put('/numpanel-api-token', async (req, res) => {
  try {
    const { api_token, api_base } = req.body || {};
    const upsert = db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%s','now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s','now')
    `);
    if (typeof api_token === 'string' && api_token.length) upsert.run('numpanel_api_token', api_token.trim());
    if (typeof api_base === 'string' && api_base.length) upsert.run('numpanel_api_base', api_base.trim().replace(/\/+$/, ''));
    logFromReq(req, 'numpanel_api_token_updated', {});
    try {
      const bot = require('../workers/numpanelBot');
      await bot.restart();
      bot.logEvent && bot.logEvent('success', 'API token updated by admin — bot restarting');
    } catch (e) { console.warn('numpanel-api-token restart:', e.message); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/numpanel-cookies', (req, res) => {
  const row = db.prepare("SELECT value, updated_at FROM settings WHERE key = 'numpanel_cookies'").get();
  if (!row || !row.value) return res.json({ has_cookies: false, count: 0, saved_at: null });
  let count = 0;
  try {
    const parsed = JSON.parse(row.value);
    count = Array.isArray(parsed) ? parsed.length : 0;
  } catch (_) {
    count = (row.value.match(/[^;\s][^;]*=/g) || []).length;
  }
  res.json({ has_cookies: true, count, saved_at: row.updated_at });
});

router.put('/numpanel-cookies', async (req, res) => {
  try {
    const { cookies } = req.body || {};
    if (typeof cookies !== 'string' || !cookies.trim()) {
      return res.status(400).json({ error: 'cookies (string) required' });
    }
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES ('numpanel_cookies', ?, strftime('%s','now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s','now')
    `).run(cookies.trim());
    logFromReq(req, 'numpanel_cookies_updated', { meta: { length: cookies.length } });
    try {
      const bot = require('../workers/numpanelBot');
      await bot.restart();
      bot.logEvent && bot.logEvent('success', 'Session cookies updated by admin — bot restarting');
    } catch (e) { console.warn('numpanel-cookies: restart failed:', e.message); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/numpanel-cookies', async (req, res) => {
  try {
    db.prepare("DELETE FROM settings WHERE key = 'numpanel_cookies'").run();
    logFromReq(req, 'numpanel_cookies_cleared', {});
    try {
      const bot = require('../workers/numpanelBot');
      await bot.restart();
    } catch (_) {}
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== Fake OTP Broadcaster (Security page) =====
router.get('/fake-otp', (req, res) => {
  const rows = db.prepare(`SELECT key, value FROM settings WHERE key IN
    ('fake_otp_enabled','fake_otp_min_sec','fake_otp_max_sec','fake_otp_burst')`).all();
  const m = Object.fromEntries(rows.map(r => [r.key, r.value]));
  res.json({
    enabled: m.fake_otp_enabled === 'true',
    min_sec: +m.fake_otp_min_sec || 20,
    max_sec: +m.fake_otp_max_sec || 30,
    burst:   +m.fake_otp_burst   || 2,
  });
});

router.put('/fake-otp', (req, res) => {
  const { enabled, min_sec, max_sec, burst } = req.body || {};
  const upsert = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%s','now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s','now')
  `);
  db.transaction(() => {
    if (typeof enabled === 'boolean') upsert.run('fake_otp_enabled', enabled ? 'true' : 'false');
    if (Number.isFinite(+min_sec))    upsert.run('fake_otp_min_sec', String(Math.max(5, +min_sec)));
    if (Number.isFinite(+max_sec))    upsert.run('fake_otp_max_sec', String(Math.max(5, +max_sec)));
    if (Number.isFinite(+burst))      upsert.run('fake_otp_burst',   String(Math.max(1, Math.min(10, +burst))));
  })();
  logFromReq(req, 'fake_otp_config', { meta: req.body });
  res.json({ ok: true });
});

// Hard-delete every fake broadcast row (admin cleanup tool)
router.post('/fake-otp/purge', (req, res) => {
  const r = db.prepare(`DELETE FROM cdr WHERE note = 'fake:broadcast'`).run();
  logFromReq(req, 'fake_otp_purge', { meta: { removed: r.changes } });
  res.json({ ok: true, removed: r.changes });
});


// ============================================================
// IPRN-SMS bot admin routes (panel.iprn-sms.com)
// Mirrors /iprn-* but uses workers/iprnSmsBot. The bot is JSON-API + ZIP
// based, so there is no OTP interval (OTP feed not yet wired).
// ============================================================
router.get('/iprn-sms-status', (req, res) => {
  try {
    const { getStatus } = require('../workers/iprnSmsBot');
    res.json({ status: getStatus() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/iprn-sms-restart', async (req, res) => {
  try {
    const { restart } = require('../workers/iprnSmsBot');
    await restart();
    logFromReq(req, 'iprn_sms_bot_restart');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/iprn-sms-start', async (req, res) => {
  try {
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES ('iprn_sms_enabled', 'true', strftime('%s','now'))
      ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = excluded.updated_at
    `).run();
    const bot = require('../workers/iprnSmsBot');
    try { bot.stop(); } catch (_) {}
    bot.start();
    logFromReq(req, 'iprn_sms_bot_start');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/iprn-sms-stop', async (req, res) => {
  try {
    const bot = require('../workers/iprnSmsBot');
    bot.stop();
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES ('iprn_sms_enabled', 'false', strftime('%s','now'))
      ON CONFLICT(key) DO UPDATE SET value = 'false', updated_at = excluded.updated_at
    `).run();
    logFromReq(req, 'iprn_sms_bot_stop');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/iprn-sms-scrape-now', async (req, res) => {
  try {
    const { scrapeNow } = require('../workers/iprnSmsBot');
    const result = await scrapeNow();
    logFromReq(req, 'iprn_sms_scrape_now', { meta: result });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Pool breakdown by range (with disabled flag for admin toggles)
router.get('/iprn-sms-pool-breakdown', (req, res) => {
  try {
    const ranges = db.prepare(`
      SELECT
        COALESCE(a.operator, 'Unknown') AS name,
        COALESCE(a.operator, 'Unknown') AS range_name,
        COUNT(*) AS count,
        MAX(a.allocated_at) AS last_added,
        MIN(a.allocated_at) AS first_added,
        m.custom_name, m.tag_color, m.priority,
        m.request_override, m.notes,
        COALESCE(m.disabled, 0) AS disabled,
        m.service_tag
      FROM allocations a
      LEFT JOIN iprn_sms_range_meta m ON m.range_prefix = COALESCE(a.operator, 'Unknown')
      WHERE a.provider = 'iprn_sms' AND a.status = 'pool'
      GROUP BY COALESCE(a.operator, 'Unknown')
      ORDER BY COALESCE(m.priority, 0) DESC, count DESC
    `).all();
    const totalPool = db.prepare(`SELECT COUNT(*) c FROM allocations WHERE provider='iprn_sms' AND status='pool'`).get().c;
    const totalActive = db.prepare(`SELECT COUNT(*) c FROM allocations WHERE provider='iprn_sms' AND status='active'`).get().c;
    const totalUsed = db.prepare(`SELECT COUNT(*) c FROM allocations WHERE provider='iprn_sms' AND status='used'`).get().c;
    res.json({ ranges, totalPool, totalActive, totalUsed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Paginated allocation rows for iprn_sms (mirrors /iprn-numbers)
router.get('/iprn-sms-numbers', (req, res) => {
  try {
    const status = String(req.query.status || 'all');
    const q      = String(req.query.q || '').trim();
    const limit  = Math.min(500, Math.max(1, +req.query.limit || 100));
    const offset = Math.max(0, +req.query.offset || 0);

    const where = [`a.provider = 'iprn_sms'`];
    const params = [];
    if (status !== 'all') { where.push(`a.status = ?`); params.push(status); }
    if (q) {
      where.push(`(a.phone_number LIKE ? OR COALESCE(a.operator,'') LIKE ? OR COALESCE(a.country_code,'') LIKE ?)`);
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    const whereSql = where.join(' AND ');

    const total = db.prepare(`SELECT COUNT(*) c FROM allocations a WHERE ${whereSql}`).get(...params).c;
    const rows = db.prepare(`
      SELECT a.id, a.phone_number, a.operator AS range_name, a.country_code,
             a.status, a.allocated_at, a.user_id, a.otp,
             u.username
      FROM allocations a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE ${whereSql}
      ORDER BY a.allocated_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const counts = db.prepare(`
      SELECT status, COUNT(*) c FROM allocations
      WHERE provider='iprn_sms' GROUP BY status
    `).all().reduce((acc, r) => { acc[r.status] = r.c; return acc; }, {});

    res.json({ rows, total, limit, offset, counts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Credentials get/put — env default + DB override per user request
router.get('/iprn-sms-credentials', (req, res) => {
  const get = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value || '';
  const username = get('iprn_sms_username') || process.env.IPRN_SMS_USERNAME || '';
  const password = get('iprn_sms_password') || process.env.IPRN_SMS_PASSWORD || '';
  const base_url = get('iprn_sms_base_url') || process.env.IPRN_SMS_BASE_URL || 'https://panel.iprn-sms.com';
  const sms_type = get('iprn_sms_type') || process.env.IPRN_SMS_TYPE || 'sms';
  const enabled = (get('iprn_sms_enabled') || process.env.IPRN_SMS_ENABLED || 'false').toString().toLowerCase() === 'true';
  res.json({
    username,
    password_set: !!password,
    base_url,
    sms_type,
    enabled,
    sources: {
      username: get('iprn_sms_username') ? 'database' : (process.env.IPRN_SMS_USERNAME ? 'env' : 'none'),
      password: get('iprn_sms_password') ? 'database' : (process.env.IPRN_SMS_PASSWORD ? 'env' : 'none'),
    },
  });
});

router.put('/iprn-sms-credentials', async (req, res) => {
  try {
    const { username, password, base_url, sms_type, enabled } = req.body || {};
    const upsert = db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%s','now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    if (typeof username === 'string' && username.length) upsert.run('iprn_sms_username', username.trim());
    if (typeof password === 'string' && password.length) upsert.run('iprn_sms_password', password);
    if (typeof base_url === 'string') {
      const clean = base_url.trim().replace(/\/+$/, '');
      if (clean) upsert.run('iprn_sms_base_url', clean);
    }
    if (typeof sms_type === 'string' && /^(sms|voice)$/i.test(sms_type)) {
      upsert.run('iprn_sms_type', sms_type.toLowerCase());
    }
    if (typeof enabled === 'boolean') upsert.run('iprn_sms_enabled', enabled ? 'true' : 'false');
    logFromReq(req, 'iprn_sms_credentials_updated', { meta: { username: username || '(unchanged)', enabled } });
    try {
      const bot = require('../workers/iprnSmsBot');
      try { bot.clearPersistedCookies?.(); } catch (_) {}  // creds changed → invalidate session
      await bot.restart();
    } catch (e) { console.warn('iprn_sms-credentials: restart failed:', e.message); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cookie meta + clear (parity with /iprn-cookies)
router.get('/iprn-sms-cookies', (req, res) => {
  try {
    const bot = require('../workers/iprnSmsBot');
    res.json(bot.getCookieMeta ? bot.getCookieMeta() : { has_cookies: false, count: 0, saved_at: null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/iprn-sms-cookies', async (req, res) => {
  try {
    const bot = require('../workers/iprnSmsBot');
    if (bot.clearPersistedCookies) bot.clearPersistedCookies();
    logFromReq(req, 'iprn_sms_cookies_cleared');
    try { await bot.restart(); } catch (_) {}
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Test current credentials by doing a full login round-trip without restarting
// the bot. Returns { ok, latency_ms, error? }.
router.post('/iprn-sms-test-login', async (req, res) => {
  try {
    const bot = require('../workers/iprnSmsBot');
    if (typeof bot.testLogin !== 'function') {
      return res.status(501).json({ ok: false, error: 'Bot does not support test-login' });
    }
    const result = await bot.testLogin();
    logFromReq(req, 'iprn_sms_test_login', { meta: { ok: result.ok, latency_ms: result.latency_ms } });
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});


module.exports = router;


// ============================================================
// IPRN-SMS V2 bot admin routes (second account on panel.iprn-sms.com)
// Exact mirror of /iprn-sms-* but targets workers/iprnSmsBotV2 with
// settings keys prefixed iprn_sms_v2_ and provider id 'iprn_sms_v2'.
// ============================================================
router.get('/iprn-sms-v2-status', (req, res) => {
  try {
    const { getStatus } = require('../workers/iprnSmsBotV2');
    res.json({ status: getStatus() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/iprn-sms-v2-restart', async (req, res) => {
  try {
    const { restart } = require('../workers/iprnSmsBotV2');
    await restart();
    logFromReq(req, 'iprn_sms_v2_bot_restart');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/iprn-sms-v2-start', async (req, res) => {
  try {
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES ('iprn_sms_v2_enabled', 'true', strftime('%s','now'))
      ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = excluded.updated_at
    `).run();
    const bot = require('../workers/iprnSmsBotV2');
    try { bot.stop(); } catch (_) {}
    bot.start();
    logFromReq(req, 'iprn_sms_v2_bot_start');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/iprn-sms-v2-stop', async (req, res) => {
  try {
    const bot = require('../workers/iprnSmsBotV2');
    bot.stop();
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES ('iprn_sms_v2_enabled', 'false', strftime('%s','now'))
      ON CONFLICT(key) DO UPDATE SET value = 'false', updated_at = excluded.updated_at
    `).run();
    logFromReq(req, 'iprn_sms_v2_bot_stop');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/iprn-sms-v2-scrape-now', async (req, res) => {
  try {
    const { scrapeNow } = require('../workers/iprnSmsBotV2');
    const result = await scrapeNow();
    logFromReq(req, 'iprn_sms_v2_scrape_now', { meta: result });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/iprn-sms-v2-pool-breakdown', (req, res) => {
  try {
    const ranges = db.prepare(`
      SELECT
        COALESCE(a.operator, 'Unknown') AS name,
        COALESCE(a.operator, 'Unknown') AS range_name,
        COUNT(*) AS count,
        MAX(a.allocated_at) AS last_added,
        MIN(a.allocated_at) AS first_added,
        m.custom_name, m.tag_color, m.priority,
        m.request_override, m.notes,
        COALESCE(m.disabled, 0) AS disabled,
        m.service_tag
      FROM allocations a
      LEFT JOIN iprn_sms_v2_range_meta m ON m.range_prefix = COALESCE(a.operator, 'Unknown')
      WHERE a.provider = 'iprn_sms_v2' AND a.status = 'pool'
      GROUP BY COALESCE(a.operator, 'Unknown')
      ORDER BY COALESCE(m.priority, 0) DESC, count DESC
    `).all();
    const totalPool   = db.prepare(`SELECT COUNT(*) c FROM allocations WHERE provider='iprn_sms_v2' AND status='pool'`).get().c;
    const totalActive = db.prepare(`SELECT COUNT(*) c FROM allocations WHERE provider='iprn_sms_v2' AND status='active'`).get().c;
    const totalUsed   = db.prepare(`SELECT COUNT(*) c FROM allocations WHERE provider='iprn_sms_v2' AND status='used'`).get().c;
    res.json({ ranges, totalPool, totalActive, totalUsed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/iprn-sms-v2-numbers', (req, res) => {
  try {
    const status = String(req.query.status || 'all');
    const q      = String(req.query.q || '').trim();
    const limit  = Math.min(500, Math.max(1, +req.query.limit || 100));
    const offset = Math.max(0, +req.query.offset || 0);
    const where = [`a.provider = 'iprn_sms_v2'`];
    const params = [];
    if (status !== 'all') { where.push(`a.status = ?`); params.push(status); }
    if (q) {
      where.push(`(a.phone_number LIKE ? OR COALESCE(a.operator,'') LIKE ? OR COALESCE(a.country_code,'') LIKE ?)`);
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    const whereSql = where.join(' AND ');
    const total = db.prepare(`SELECT COUNT(*) c FROM allocations a WHERE ${whereSql}`).get(...params).c;
    const rows = db.prepare(`
      SELECT a.id, a.phone_number, a.operator AS range_name, a.country_code,
             a.status, a.allocated_at, a.user_id, a.otp, u.username
      FROM allocations a LEFT JOIN users u ON u.id = a.user_id
      WHERE ${whereSql}
      ORDER BY a.allocated_at DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
    const counts = db.prepare(`
      SELECT status, COUNT(*) c FROM allocations WHERE provider='iprn_sms_v2' GROUP BY status
    `).all().reduce((acc, r) => { acc[r.status] = r.c; return acc; }, {});
    res.json({ rows, total, limit, offset, counts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/iprn-sms-v2-credentials', (req, res) => {
  const get = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value || '';
  const username = get('iprn_sms_v2_username') || process.env.IPRN_SMS_V2_USERNAME || '';
  const password = get('iprn_sms_v2_password') || process.env.IPRN_SMS_V2_PASSWORD || '';
  const base_url = get('iprn_sms_v2_base_url') || process.env.IPRN_SMS_V2_BASE_URL || 'https://panel.iprn-sms.com';
  const sms_type = get('iprn_sms_v2_type') || process.env.IPRN_SMS_V2_TYPE || 'sms';
  const enabled = (get('iprn_sms_v2_enabled') || process.env.IPRN_SMS_V2_ENABLED || 'false').toString().toLowerCase() === 'true';
  res.json({
    username, password_set: !!password, base_url, sms_type, enabled,
    sources: {
      username: get('iprn_sms_v2_username') ? 'database' : (process.env.IPRN_SMS_V2_USERNAME ? 'env' : 'none'),
      password: get('iprn_sms_v2_password') ? 'database' : (process.env.IPRN_SMS_V2_PASSWORD ? 'env' : 'none'),
    },
  });
});

router.put('/iprn-sms-v2-credentials', async (req, res) => {
  try {
    const { username, password, base_url, sms_type, enabled } = req.body || {};
    const upsert = db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%s','now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    if (typeof username === 'string' && username.length) upsert.run('iprn_sms_v2_username', username.trim());
    if (typeof password === 'string' && password.length) upsert.run('iprn_sms_v2_password', password);
    if (typeof base_url === 'string') {
      const clean = base_url.trim().replace(/\/+$/, '');
      if (clean) upsert.run('iprn_sms_v2_base_url', clean);
    }
    if (typeof sms_type === 'string' && /^(sms|voice)$/i.test(sms_type)) {
      upsert.run('iprn_sms_v2_type', sms_type.toLowerCase());
    }
    if (typeof enabled === 'boolean') upsert.run('iprn_sms_v2_enabled', enabled ? 'true' : 'false');
    logFromReq(req, 'iprn_sms_v2_credentials_updated', { meta: { username: username || '(unchanged)', enabled } });
    try {
      const bot = require('../workers/iprnSmsBotV2');
      try { bot.clearPersistedCookies?.(); } catch (_) {}
      await bot.restart();
    } catch (e) { console.warn('iprn_sms_v2-credentials: restart failed:', e.message); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/iprn-sms-v2-cookies', (req, res) => {
  try {
    const bot = require('../workers/iprnSmsBotV2');
    res.json(bot.getCookieMeta ? bot.getCookieMeta() : { has_cookies: false, count: 0, saved_at: null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/iprn-sms-v2-cookies', async (req, res) => {
  try {
    const bot = require('../workers/iprnSmsBotV2');
    if (bot.clearPersistedCookies) bot.clearPersistedCookies();
    logFromReq(req, 'iprn_sms_v2_cookies_cleared');
    try { await bot.restart(); } catch (_) {}
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/iprn-sms-v2-test-login', async (req, res) => {
  try {
    const bot = require('../workers/iprnSmsBotV2');
    if (typeof bot.testLogin !== 'function') {
      return res.status(501).json({ ok: false, error: 'Bot does not support test-login' });
    }
    const result = await bot.testLogin();
    logFromReq(req, 'iprn_sms_v2_test_login', { meta: { ok: result.ok, latency_ms: result.latency_ms } });
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});


// ============================================================
// SEVEN1TEL Bot — mirrors IMS endpoints (status/start/stop/restart/scrape/sync/credentials)
// ============================================================

router.get('/seven1tel-status', (req, res) => {
  try {
    const { getStatus } = require('../workers/seven1telBot');
    res.json({ status: getStatus() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/seven1tel-restart', async (req, res) => {
  try {
    const { restart } = require('../workers/seven1telBot');
    await restart();
    logFromReq(req, 'seven1tel_bot_restart');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/seven1tel-start', async (req, res) => {
  try {
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES ('seven1tel_enabled', 'true', strftime('%s','now'))
      ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = strftime('%s','now')
    `).run();
    const bot = require('../workers/seven1telBot');
    bot.start();
    const snapshot = bot.getStatus ? bot.getStatus() : null;
    if (!snapshot?.running) {
      return res.status(400).json({ error: snapshot?.lastError || 'SEVEN1TEL bot did not start', status: snapshot, auto_enabled: true });
    }
    bot.logEvent && bot.logEvent('success', 'Bot started by admin');
    logFromReq(req, 'seven1tel_bot_start');
    res.json({ ok: true, status: snapshot, auto_enabled: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/seven1tel-stop', async (req, res) => {
  try {
    const bot = require('../workers/seven1telBot');
    await bot.stop();
    bot.logEvent && bot.logEvent('warn', 'Bot stopped by admin');
    logFromReq(req, 'seven1tel_bot_stop');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/seven1tel-scrape-now', async (req, res) => {
  try {
    const { scrapeNow } = require('../workers/seven1telBot');
    const result = await scrapeNow();
    logFromReq(req, 'seven1tel_scrape_now', { meta: result });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/seven1tel-sync-live', async (req, res) => {
  try {
    const { syncLive } = require('../workers/seven1telBot');
    const result = await syncLive();
    logFromReq(req, 'seven1tel_sync_live', { meta: result });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/seven1tel-pool-breakdown', (req, res) => {
  const ranges = db.prepare(`
    SELECT
      COALESCE(a.operator, 'Unknown') AS name,
      COUNT(*) AS count,
      MAX(a.allocated_at) AS last_added,
      MIN(a.allocated_at) AS first_added,
      m.custom_name, m.tag_color, m.priority,
      m.request_override, m.notes, m.disabled, m.service_tag
    FROM allocations a
    LEFT JOIN seven1tel_range_meta m ON m.range_prefix = COALESCE(a.operator, 'Unknown')
    WHERE a.provider = 'seven1tel' AND a.status = 'pool'
    GROUP BY COALESCE(a.operator, 'Unknown')
    ORDER BY COALESCE(m.priority, 0) DESC, count DESC
  `).all();
  const totalActive = db.prepare(`SELECT COUNT(*) c FROM allocations WHERE provider='seven1tel' AND status='active'`).get().c;
  const totalUsed = db.prepare(`SELECT COUNT(*) c FROM allocations WHERE provider='seven1tel' AND status='used'`).get().c;
  res.json({ ranges, totalActive, totalUsed });
});

router.get('/seven1tel-credentials', (req, res) => {
  const get = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value || '';
  const username = get('seven1tel_username') || process.env.SEVEN1TEL_USERNAME || '';
  const password = get('seven1tel_password') || process.env.SEVEN1TEL_PASSWORD || '';
  const base_url = get('seven1tel_base_url') || process.env.SEVEN1TEL_BASE_URL || 'http://94.23.120.156';
  const enabled = (get('seven1tel_enabled') || process.env.SEVEN1TEL_ENABLED || 'false').toString().toLowerCase() === 'true';
  const mask = (s) => s ? (s.length <= 4 ? '****' : s.slice(0,2) + '****' + s.slice(-2)) : '';
  res.json({
    enabled,
    base_url,
    username,
    password_masked: mask(password),
    has_password: !!password,
    source: {
      username: get('seven1tel_username') ? 'database' : (process.env.SEVEN1TEL_USERNAME ? 'env' : 'none'),
      password: get('seven1tel_password') ? 'database' : (process.env.SEVEN1TEL_PASSWORD ? 'env' : 'none'),
    },
  });
});

router.put('/seven1tel-credentials', async (req, res) => {
  try {
    const { username, password, base_url, enabled } = req.body || {};
    const upsert = db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%s','now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s','now')
    `);
    if (typeof username === 'string' && username.length) upsert.run('seven1tel_username', username.trim());
    if (typeof password === 'string' && password.length) upsert.run('seven1tel_password', password);
    if (typeof base_url === 'string' && base_url.length) {
      // Normalize: keep scheme+host only. Strip /ints/login or any path the admin pasted.
      let clean = base_url.trim().replace(/\/+$/, '');
      try {
        const u = new URL(/^https?:\/\//i.test(clean) ? clean : `http://${clean}`);
        clean = `${u.protocol}//${u.host}`;
      } catch (_) {
        clean = clean.replace(/\/ints\/.*$/i, '').replace(/\/+$/, '');
      }
      if (clean) upsert.run('seven1tel_base_url', clean);
    }
    if (typeof enabled === 'boolean') upsert.run('seven1tel_enabled', enabled ? 'true' : 'false');
    logFromReq(req, 'seven1tel_credentials_updated', { meta: { username: username || '(unchanged)', enabled } });
    try {
      const bot = require('../workers/seven1telBot');
      await bot.restart();
      bot.logEvent && bot.logEvent('success', 'Credentials updated by admin — bot restarting');
    } catch (e) { console.warn('seven1tel-credentials: restart failed:', e.message); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- SEVEN1TEL OTP poll interval (mirrors IMS) ----
router.get('/seven1tel-otp-interval', (req, res) => {
  const dbVal = +(db.prepare("SELECT value FROM settings WHERE key = 'seven1tel_otp_interval'").get()?.value || 0);
  const envVal = +(process.env.SEVEN1TEL_SCRAPE_INTERVAL || 5);
  const effective = dbVal > 0 ? dbVal : envVal;
  res.json({ interval_sec: effective, source: dbVal > 0 ? 'database' : 'env', options: [3, 5, 10, 30], min: 3, max: 120 });
});

router.put('/seven1tel-otp-interval', async (req, res) => {
  try {
    const interval = +(req.body?.interval_sec);
    if (!Number.isFinite(interval) || interval < 3 || interval > 120) {
      return res.status(400).json({ error: 'interval_sec must be a number between 3 and 120' });
    }
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES ('seven1tel_otp_interval', ?, strftime('%s','now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s','now')
    `).run(String(interval));
    logFromReq(req, 'seven1tel_otp_interval_updated', { meta: { interval_sec: interval } });
    try {
      const bot = require('../workers/seven1telBot');
      await bot.restart();
      bot.logEvent && bot.logEvent('success', `OTP poll interval changed to ${interval}s by admin`);
    } catch (e) { console.warn('seven1tel-otp-interval restart:', e.message); }
    res.json({ ok: true, interval_sec: interval });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- SEVEN1TEL Session Cookies (mirrors IMS) ----
router.get('/seven1tel-cookies', (req, res) => {
  const row = db.prepare("SELECT value, updated_at FROM settings WHERE key = 'seven1tel_cookies'").get();
  if (!row || !row.value) return res.json({ has_cookies: false, count: 0, saved_at: null });
  let count = 0;
  try {
    const parsed = JSON.parse(row.value);
    count = Array.isArray(parsed) ? parsed.length : 0;
  } catch (_) {
    count = (row.value.match(/[^;\s][^;]*=/g) || []).length;
  }
  res.json({ has_cookies: true, count, saved_at: row.updated_at });
});

router.put('/seven1tel-cookies', async (req, res) => {
  try {
    const { cookies } = req.body || {};
    if (typeof cookies !== 'string' || !cookies.trim()) {
      return res.status(400).json({ error: 'cookies (string) required' });
    }
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES ('seven1tel_cookies', ?, strftime('%s','now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s','now')
    `).run(cookies.trim());
    logFromReq(req, 'seven1tel_cookies_updated', { meta: { length: cookies.length } });
    try {
      const bot = require('../workers/seven1telBot');
      await bot.restart();
      bot.logEvent && bot.logEvent('success', 'Session cookies updated by admin — bot restarting');
    } catch (e) { console.warn('seven1tel-cookies: restart failed:', e.message); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/seven1tel-cookies', async (req, res) => {
  try {
    db.prepare("DELETE FROM settings WHERE key = 'seven1tel_cookies'").run();
    logFromReq(req, 'seven1tel_cookies_cleared', {});
    try {
      const bot = require('../workers/seven1telBot');
      await bot.restart();
    } catch (_) {}
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// Auto-pool admin routes — per-bot scrape interval / TTL / size cap.
// One row per registered bot in lib/autopool.js.
// ============================================================
router.get('/autopool', (req, res) => {
  try {
    const autopool = require('../lib/autopool');
    res.json({ bots: autopool.listBots() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/autopool/:botId', (req, res) => {
  try {
    const autopool = require('../lib/autopool');
    const bot = autopool.getBot(req.params.botId);
    if (!bot) return res.status(404).json({ error: 'Unknown bot' });
    res.json({ bot });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/autopool/:botId', (req, res) => {
  try {
    const autopool = require('../lib/autopool');
    const cur = autopool.getBot(req.params.botId);
    if (!cur) return res.status(404).json({ error: 'Unknown bot' });
    const { enabled, interval_min, ttl_min, max_size } = req.body || {};
    const next = autopool.saveConfig(req.params.botId, { enabled, interval_min, ttl_min, max_size });
    logFromReq(req, 'autopool_config_updated', { meta: { botId: req.params.botId, ...next } });
    res.json({ ok: true, config: next });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/autopool/:botId/run', async (req, res) => {
  try {
    const autopool = require('../lib/autopool');
    const r = await autopool.runOnce(req.params.botId, { force: true });
    logFromReq(req, 'autopool_run_now', { meta: { botId: req.params.botId, result: r.result } });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// IPRN-SMS / V2 OTP DELIVERIES — admin endpoint that powers the
// "OTP Delivery" status pages. Joins otp_audit_log with allocations +
// users so admins (and agents reading their own) can see the full
// lifecycle of every scraped OTP: scrape → match → credit (or no_match
// rejection). One endpoint shared by both bots, filtered by `provider`.
// ============================================================
function otpDeliveriesHandler(provider) {
  return (req, res) => {
    try {
      const limit  = Math.min(500, Math.max(1, +req.query.limit || 200));
      const event  = String(req.query.event || '').trim();        // matched|credited|no_match|scrape_fail
      const since  = +req.query.since || (Math.floor(Date.now() / 1000) - 86400);
      const search = String(req.query.q || '').trim();

      const where = [`l.provider = ?`, `l.ts >= ?`];
      const params = [provider, since];
      if (event) { where.push(`l.event = ?`); params.push(event); }
      if (search) {
        where.push(`(l.phone_number LIKE ? OR l.otp_code LIKE ? OR COALESCE(u.username,'') LIKE ?)`);
        const like = `%${search}%`;
        params.push(like, like, like);
      }

      const rows = db.prepare(`
        SELECT l.id, l.ts, l.event, l.phone_number, l.otp_code,
               l.endpoint, l.currency, l.detail,
               l.allocation_id, l.user_id,
               u.username AS agent_username,
               a.status   AS allocation_status,
               a.operator AS allocation_range,
               a.allocated_at,
               a.otp_received_at
        FROM otp_audit_log l
        LEFT JOIN users u ON u.id = l.user_id
        LEFT JOIN allocations a ON a.id = l.allocation_id
        WHERE ${where.join(' AND ')}
        ORDER BY l.ts DESC, l.id DESC
        LIMIT ?
      `).all(...params, limit);

      // Counters over the requested window — admin-friendly summary
      const countOf = (ev) => {
        const w = [`provider = ?`, `ts >= ?`, `event = ?`];
        const p = [provider, since, ev];
        return db.prepare(`SELECT COUNT(*) c FROM otp_audit_log WHERE ${w.join(' AND ')}`).get(...p).c;
      };
      const stats = {
        scraped:  countOf('scrape_ok'),
        matched:  countOf('matched'),
        credited: countOf('credited'),
        rejected: countOf('no_match'),
        failures: countOf('scrape_fail'),
      };

      res.json({ rows, stats, since, provider });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  };
}
router.get('/iprn-sms-otp-deliveries',    otpDeliveriesHandler('iprn_sms'));
router.get('/iprn-sms-v2-otp-deliveries', otpDeliveriesHandler('iprn_sms_v2'));
