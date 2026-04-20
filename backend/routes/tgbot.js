// Admin routes for Telegram bot management
const express = require('express');
const db = require('../lib/db');
const { authRequired, adminOnly } = require('../middleware/auth');
const { logFromReq } = require('../lib/audit');
const { bestCountryCode } = require('../lib/countryInfer');

const router = express.Router();
router.use(authRequired, adminOnly);

const now = () => Math.floor(Date.now() / 1000);

// ---------- STATUS ----------
router.get('/status', (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) c FROM tg_users').get().c;
  const activeUsers = db.prepare("SELECT COUNT(*) c FROM tg_users WHERE status = 'active'").get().c;
  const onlineUsers = db.prepare('SELECT COUNT(*) c FROM tg_users WHERE last_seen_at > ?').get(now() - 600).c;
  const todayOtps = db.prepare("SELECT COUNT(*) c FROM tg_assignments WHERE status='otp_received' AND otp_received_at >= ?")
    .get(Math.floor(new Date().setHours(0,0,0,0) / 1000)).c;
  const activeNumbers = db.prepare("SELECT COUNT(*) c FROM tg_assignments WHERE status='active' AND expires_at > ?").get(now()).c;
  const totalDelivered = db.prepare("SELECT COUNT(*) c FROM tg_assignments WHERE status='otp_received'").get().c;
  const enabledRanges = db.prepare("SELECT COUNT(*) c FROM range_tg_settings WHERE tg_enabled = 1").get().c;
  const totalRevenue = db.prepare(
    "SELECT COALESCE(-SUM(amount_bdt),0) s FROM tg_wallet_tx WHERE type='deduct'"
  ).get().s;

  res.json({
    totalUsers, activeUsers, onlineUsers, todayOtps, activeNumbers, totalDelivered,
    enabledRanges, totalRevenue,
  });
});

// ---------- USERS ----------
router.get('/users', (req, res) => {
  const page = Math.max(1, +req.query.page || 1);
  const ps   = Math.min(200, +req.query.page_size || 50);
  const q    = (req.query.q || '').toString().trim();
  const where = q ? `WHERE username LIKE ? OR first_name LIKE ? OR CAST(tg_user_id AS TEXT) LIKE ?` : '';
  const args  = q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [];
  const total = db.prepare(`SELECT COUNT(*) c FROM tg_users ${where}`).get(...args).c;
  const rows = db.prepare(`
    SELECT * FROM tg_users ${where} ORDER BY last_seen_at DESC LIMIT ? OFFSET ?
  `).all(...args, ps, (page - 1) * ps);
  res.json({ rows, page, page_size: ps, total, total_pages: Math.ceil(total / ps) });
});

router.post('/users/:id/topup', (req, res) => {
  const id = +req.params.id;
  const amount = +req.body.amount;
  const note = (req.body.note || '').toString().slice(0, 200);
  if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: 'Invalid amount' });
  const u = db.prepare('SELECT * FROM tg_users WHERE tg_user_id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'TG user not found' });
  db.transaction(() => {
    db.prepare('UPDATE tg_users SET balance_bdt = balance_bdt + ? WHERE tg_user_id = ?').run(amount, id);
    db.prepare('INSERT INTO tg_wallet_tx (tg_user_id, amount_bdt, type, note, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(id, amount, amount > 0 ? 'topup' : 'adjust', note || (amount > 0 ? 'Admin top-up' : 'Admin adjust'), req.user.id);
  })();
  logFromReq(req, 'tgbot_topup', { targetType: 'tg_user', targetId: id, meta: { amount, note } });
  res.json({ ok: true });
});

router.post('/users/:id/ban', (req, res) => {
  const id = +req.params.id;
  const ban = !!req.body.ban;
  const u = db.prepare('SELECT * FROM tg_users WHERE tg_user_id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'TG user not found' });
  db.prepare('UPDATE tg_users SET status = ? WHERE tg_user_id = ?').run(ban ? 'banned' : 'active', id);
  logFromReq(req, ban ? 'tgbot_ban' : 'tgbot_unban', { targetType: 'tg_user', targetId: id });
  res.json({ ok: true });
});

// ---------- RANGE SETTINGS ----------
// list every (provider, range) currently in pool, enriched with TG settings
router.get('/range-settings', (req, res) => {
  const pools = db.prepare(`
    SELECT provider, COALESCE(operator,'Unknown') AS range_name,
           country_code, COUNT(*) AS pool_count
    FROM allocations WHERE status = 'pool'
    GROUP BY provider, range_name, country_code
    ORDER BY provider, range_name
  `).all();
  const settings = db.prepare('SELECT * FROM range_tg_settings').all();
  const map = new Map(settings.map(s => [`${s.provider}::${s.range_name}`, s]));
  const merged = pools.map(p => {
    const k = `${p.provider}::${p.range_name}`;
    const s = map.get(k) || { tg_enabled: 0, tg_rate_bdt: 0, service: null };
    return {
      provider: p.provider, range_name: p.range_name, country_code: p.country_code,
      pool_count: p.pool_count, tg_enabled: !!s.tg_enabled,
      tg_rate_bdt: s.tg_rate_bdt || 0, service: s.service || null,
    };
  });
  res.json({ ranges: merged });
});

router.put('/range-settings', (req, res) => {
  const { provider, range_name, tg_enabled, tg_rate_bdt, service } = req.body || {};
  if (!provider || !range_name) return res.status(400).json({ error: 'provider + range_name required' });
  db.prepare(`
    INSERT INTO range_tg_settings (provider, range_name, tg_enabled, tg_rate_bdt, service, updated_at)
    VALUES (?, ?, ?, ?, ?, strftime('%s','now'))
    ON CONFLICT(provider, range_name) DO UPDATE SET
      tg_enabled = excluded.tg_enabled,
      tg_rate_bdt = excluded.tg_rate_bdt,
      service = excluded.service,
      updated_at = strftime('%s','now')
  `).run(provider, range_name, tg_enabled ? 1 : 0, +tg_rate_bdt || 0, service || null);
  logFromReq(req, 'tgbot_range_update', { meta: { provider, range_name, tg_enabled, tg_rate_bdt, service } });
  res.json({ ok: true });
});

// Bulk enable / disable
router.post('/range-settings/bulk', (req, res) => {
  const { provider, country_code, tg_enabled, tg_rate_bdt, service } = req.body || {};
  if (!provider) return res.status(400).json({ error: 'provider required' });
  const where = country_code ? 'AND country_code = ?' : '';
  const args = country_code ? [provider, country_code] : [provider];
  const ranges = db.prepare(`
    SELECT DISTINCT COALESCE(operator,'Unknown') AS range_name FROM allocations
    WHERE status = 'pool' AND provider = ? ${where}
  `).all(...args);
  const stmt = db.prepare(`
    INSERT INTO range_tg_settings (provider, range_name, tg_enabled, tg_rate_bdt, service, updated_at)
    VALUES (?, ?, ?, ?, ?, strftime('%s','now'))
    ON CONFLICT(provider, range_name) DO UPDATE SET
      tg_enabled = excluded.tg_enabled,
      tg_rate_bdt = COALESCE(excluded.tg_rate_bdt, range_tg_settings.tg_rate_bdt),
      service = COALESCE(excluded.service, range_tg_settings.service),
      updated_at = strftime('%s','now')
  `);
  db.transaction(() => {
    for (const r of ranges) stmt.run(provider, r.range_name, tg_enabled ? 1 : 0, +tg_rate_bdt || 0, service || null);
  })();
  logFromReq(req, 'tgbot_range_bulk', { meta: { provider, country_code, tg_enabled, count: ranges.length } });
  res.json({ ok: true, updated: ranges.length });
});

// ---------- OTP FEED ----------
router.get('/otp-feed', (req, res) => {
  const limit = Math.min(200, +req.query.limit || 50);
  const rows = db.prepare(`
    SELECT t.id, t.tg_user_id, t.phone_number, t.country_code, t.range_name, t.service,
           t.otp_code, t.otp_received_at, t.rate_bdt, u.username AS tg_username
    FROM tg_assignments t
    LEFT JOIN tg_users u ON u.tg_user_id = t.tg_user_id
    WHERE t.status = 'otp_received'
    ORDER BY t.otp_received_at DESC LIMIT ?
  `).all(limit);
  res.json({ rows });
});

// ---------- BROADCAST ----------
router.post('/broadcast', (req, res) => {
  const message = (req.body.message || '').toString();
  if (!message.trim()) return res.status(400).json({ error: 'Message required' });
  const r = db.prepare('INSERT INTO tg_broadcasts (message, parse_mode, status, created_by) VALUES (?, ?, ?, ?)')
    .run(message, 'HTML', 'pending', req.user.id);
  logFromReq(req, 'tgbot_broadcast', { meta: { id: r.lastInsertRowid, len: message.length } });
  // Worker process picks it up — see tgbot/index.js extension below
  res.json({ ok: true, id: r.lastInsertRowid });
});

router.get('/broadcasts', (req, res) => {
  const rows = db.prepare(`
    SELECT b.*, u.username AS admin_username
    FROM tg_broadcasts b
    LEFT JOIN users u ON u.id = b.created_by
    ORDER BY b.created_at DESC LIMIT 50
  `).all();
  res.json({ broadcasts: rows });
});

module.exports = router;
