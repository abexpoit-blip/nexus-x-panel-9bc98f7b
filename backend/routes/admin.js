const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../lib/db');
const {
  authRequired, adminOnly,
  signImpersonationToken, recordSession, setAuthCookie,
} = require('../middleware/auth');
const { logFromReq } = require('../lib/audit');

const router = express.Router();
router.use(authRequired, adminOnly);

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
    const out = [];
    for (const meta of providers.list()) {
      const p = providers.get(meta.id);
      if (typeof p.getStatus === 'function') {
        try { out.push(await p.getStatus()); }
        catch (e) { out.push({ id: meta.id, name: meta.name, configured: false, lastError: e.message }); }
      } else {
        out.push({ id: meta.id, name: meta.name, configured: true, lastError: null });
      }
    }
    res.json({ providers: out });
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

// ---- Generic Range Metadata Routes (numpanel | ims | msi) ----
const RANGE_META_TABLES = {
  numpanel: 'numpanel_range_meta',
  ims: 'ims_range_meta',
  msi: 'msi_range_meta',
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
// IPRN Bot — mirrors MSI route surface (HTTP-only, no cookies/captcha)
// ============================================================

router.get('/iprn-status', (req, res) => {
  try {
    const { getStatus } = require('../workers/iprnBot');
    res.json({ status: getStatus() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/iprn-restart', async (req, res) => {
  try {
    const { restart } = require('../workers/iprnBot');
    await restart();
    logFromReq(req, 'iprn_bot_restart');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/iprn-start', async (req, res) => {
  try {
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES ('iprn_enabled', 'true', strftime('%s','now'))
      ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = strftime('%s','now')
    `).run();
    const bot = require('../workers/iprnBot');
    bot.start();
    const snapshot = bot.getStatus ? bot.getStatus() : null;
    if (!snapshot?.running) {
      return res.status(400).json({ error: snapshot?.lastError || 'IPRN bot did not start', status: snapshot, auto_enabled: true });
    }
    bot.logEvent && bot.logEvent('success', 'Bot started by admin');
    logFromReq(req, 'iprn_bot_start');
    res.json({ ok: true, status: snapshot, auto_enabled: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/iprn-stop', async (req, res) => {
  try {
    const bot = require('../workers/iprnBot');
    bot.stop();
    bot.logEvent && bot.logEvent('warn', 'Bot stopped by admin');
    logFromReq(req, 'iprn_bot_stop');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/iprn-scrape-now', async (req, res) => {
  try {
    const { scrapeNow } = require('../workers/iprnBot');
    const result = await scrapeNow();
    logFromReq(req, 'iprn_scrape_now', { meta: result });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/iprn-pool-breakdown', (req, res) => {
  const ranges = db.prepare(`
    SELECT
      COALESCE(a.operator, 'Unknown') AS name,
      COUNT(*) AS count,
      MAX(a.allocated_at) AS last_added,
      MIN(a.allocated_at) AS first_added,
      m.custom_name, m.tag_color, m.priority,
      m.request_override, m.notes, m.disabled, m.service_tag
    FROM allocations a
    LEFT JOIN iprn_range_meta m ON m.range_prefix = COALESCE(a.operator, 'Unknown')
    WHERE a.provider = 'iprn' AND a.status = 'pool'
    GROUP BY COALESCE(a.operator, 'Unknown')
    ORDER BY COALESCE(m.priority, 0) DESC, count DESC
  `).all();
  const totalActive = db.prepare(`SELECT COUNT(*) c FROM allocations WHERE provider='iprn' AND status='active'`).get().c;
  const totalUsed = db.prepare(`SELECT COUNT(*) c FROM allocations WHERE provider='iprn' AND status='used'`).get().c;
  res.json({ ranges, totalActive, totalUsed });
});

router.get('/iprn-credentials', (req, res) => {
  const get = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value || '';
  const username = get('iprn_username') || process.env.IPRN_USERNAME || '';
  const password = get('iprn_password') || process.env.IPRN_PASSWORD || '';
  const base_url = get('iprn_base_url') || process.env.IPRN_BASE_URL || 'https://iprndata.com';
  const enabled = (get('iprn_enabled') || process.env.IPRN_ENABLED || 'false').toString().toLowerCase() === 'true';
  const mask = (s) => s ? (s.length <= 4 ? '****' : s.slice(0,2) + '****' + s.slice(-2)) : '';
  res.json({
    enabled,
    base_url,
    username,
    password_masked: mask(password),
    has_password: !!password,
    source: {
      username: get('iprn_username') ? 'database' : (process.env.IPRN_USERNAME ? 'env' : 'none'),
      password: get('iprn_password') ? 'database' : (process.env.IPRN_PASSWORD ? 'env' : 'none'),
    },
  });
});

router.put('/iprn-credentials', async (req, res) => {
  try {
    const { username, password, base_url, enabled } = req.body || {};
    const upsert = db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%s','now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s','now')
    `);
    if (typeof username === 'string' && username.length) upsert.run('iprn_username', username.trim());
    if (typeof password === 'string' && password.length) upsert.run('iprn_password', password);
    if (typeof base_url === 'string' && base_url.length) {
      let clean = base_url.trim().replace(/\/+$/, '');
      try {
        const u = new URL(/^https?:\/\//i.test(clean) ? clean : `https://${clean}`);
        clean = `${u.protocol}//${u.host}`;
      } catch (_) {
        clean = clean.replace(/\/+$/, '');
      }
      if (clean) upsert.run('iprn_base_url', clean);
    }
    if (typeof enabled === 'boolean') upsert.run('iprn_enabled', enabled ? 'true' : 'false');
    logFromReq(req, 'iprn_credentials_updated', { meta: { username: username || '(unchanged)', enabled } });
    try {
      const bot = require('../workers/iprnBot');
      await bot.restart();
      bot.logEvent && bot.logEvent('success', 'Credentials updated by admin — bot restarting');
    } catch (e) { console.warn('iprn-credentials: restart failed:', e.message); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/iprn-otp-interval', (req, res) => {
  const dbVal = +(db.prepare("SELECT value FROM settings WHERE key = 'iprn_otp_interval'").get()?.value || 0);
  const envVal = +(process.env.IPRN_SCRAPE_INTERVAL || 4);
  const effective = dbVal > 0 ? dbVal : envVal;
  res.json({ interval_sec: effective, source: dbVal > 0 ? 'database' : 'env', options: [2, 4, 10, 30], min: 2, max: 120 });
});

router.put('/iprn-otp-interval', async (req, res) => {
  try {
    const interval = +(req.body?.interval_sec);
    if (!Number.isFinite(interval) || interval < 2 || interval > 120) {
      return res.status(400).json({ error: 'interval_sec must be a number between 2 and 120' });
    }
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES ('iprn_otp_interval', ?, strftime('%s','now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s','now')
    `).run(String(interval));
    logFromReq(req, 'iprn_otp_interval_updated', { meta: { interval_sec: interval } });
    try {
      const bot = require('../workers/iprnBot');
      await bot.restart();
      bot.logEvent && bot.logEvent('success', `OTP poll interval changed to ${interval}s by admin`);
    } catch (e) { console.warn('iprn-otp-interval restart:', e.message); }
    res.json({ ok: true, interval_sec: interval });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


module.exports = router;

