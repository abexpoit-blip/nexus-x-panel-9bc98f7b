const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../lib/db');
const { authRequired, adminOnly } = require('../middleware/auth');
const { logFromReq } = require('../lib/audit');

const router = express.Router();
router.use(authRequired, adminOnly);

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

  res.json({ totalAgents, activeAgents, totalAlloc, activeAlloc, totalOtp, todayOtp, todayRevenue, totalRevenue });
});

// GET /api/admin/leaderboard
router.get('/leaderboard', (req, res) => {
  const leaderboard = db.prepare(`
    SELECT id, username, otp_count FROM users
    WHERE role = 'agent' ORDER BY otp_count DESC LIMIT 20
  `).all();
  res.json({ leaderboard });
});

// GET /api/admin/agents
router.get('/agents', (req, res) => {
  const agents = db.prepare(`
    SELECT id, username, role, full_name, phone, telegram, balance, otp_count,
           daily_limit, per_request_limit, status, created_at
    FROM users WHERE role = 'agent' ORDER BY created_at DESC
  `).all();
  res.json({ agents });
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

module.exports = router;
