const express = require('express');
const db = require('../lib/db');
const { authRequired, adminOnly } = require('../middleware/auth');
const { logFromReq } = require('../lib/audit');
const { getPaymentConfig, savePaymentConfig, ALL_METHODS } = require('../lib/settings');

const router = express.Router();

// GET /api/payments — admin sees all
router.get('/', authRequired, adminOnly, (req, res) => {
  const payments = db.prepare(`
    SELECT p.*, u.username FROM payments p
    LEFT JOIN users u ON u.id = p.user_id
    ORDER BY p.created_at DESC LIMIT 500
  `).all();
  res.json({ payments });
});

// GET /api/payments/mine
router.get('/mine', authRequired, (req, res) => {
  const payments = db.prepare(
    'SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 200'
  ).all(req.user.id);
  res.json({ payments });
});

// POST /api/payments/topup — admin adds balance to agent
router.post('/topup', authRequired, adminOnly, (req, res) => {
  const { user_id, amount_bdt, method = 'admin', reference, note } = req.body || {};
  const amt = +amount_bdt;
  if (!user_id || !amt || amt <= 0) return res.status(400).json({ error: 'user_id and positive amount_bdt required' });
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(user_id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amt, user_id);
    db.prepare(`
      INSERT INTO payments (user_id, amount_bdt, type, method, reference, note)
      VALUES (?, ?, 'topup', ?, ?, ?)
    `).run(user_id, amt, method, reference || null, note || null);
  });
  tx();

  logFromReq(req, 'topup', { targetType: 'user', targetId: user_id, meta: { amount: amt } });
  res.json({ ok: true });
});

// =========== WITHDRAWALS ===========

// GET /api/withdrawals/policy — public to authed users
// Returns dynamic config so agent UI shows only admin-enabled methods.
router.get('/withdrawals/policy', authRequired, (_req, res) => {
  const cfg = getPaymentConfig();
  res.json({
    min_amount: cfg.min_amount,
    fee_percent: cfg.fee_percent,
    sla_hours: cfg.sla_hours,
    methods: cfg.methods,
    methods_enabled: cfg.methods_enabled,
  });
});

// GET /api/admin/payment-config — admin reads full config
router.get('/admin/payment-config', authRequired, adminOnly, (_req, res) => {
  res.json(getPaymentConfig());
});

// PUT /api/admin/payment-config — admin updates
router.put('/admin/payment-config', authRequired, adminOnly, (req, res) => {
  const { min_amount, fee_percent, sla_hours, methods } = req.body || {};
  if (methods && typeof methods === 'object') {
    const anyOn = ALL_METHODS.some((m) => !!methods[m]);
    if (!anyOn) return res.status(400).json({ error: 'At least one payment method must be enabled' });
  }
  if (min_amount !== undefined && (!Number.isFinite(+min_amount) || +min_amount < 1)) {
    return res.status(400).json({ error: 'min_amount must be a positive number' });
  }
  if (fee_percent !== undefined && (!Number.isFinite(+fee_percent) || +fee_percent < 0 || +fee_percent > 50)) {
    return res.status(400).json({ error: 'fee_percent must be 0-50' });
  }
  if (sla_hours !== undefined && (!Number.isFinite(+sla_hours) || +sla_hours < 1 || +sla_hours > 168)) {
    return res.status(400).json({ error: 'sla_hours must be 1-168' });
  }
  const updated = savePaymentConfig({ min_amount, fee_percent, sla_hours, methods });
  logFromReq(req, 'payment_config_update', { meta: { min_amount, fee_percent, sla_hours, methods } });
  res.json(updated);
});

// GET /api/withdrawals — admin sees all (filterable)
router.get('/withdrawals', authRequired, adminOnly, (req, res) => {
  const { status } = req.query;
  let q = `SELECT w.*, u.username FROM withdrawals w LEFT JOIN users u ON u.id = w.user_id`;
  const params = [];
  if (status) { q += ' WHERE w.status = ?'; params.push(status); }
  q += ' ORDER BY w.created_at DESC LIMIT 500';
  res.json({ withdrawals: db.prepare(q).all(...params) });
});

// GET /api/withdrawals/pending — admin shortcut
router.get('/withdrawals/pending', authRequired, adminOnly, (_req, res) => {
  const withdrawals = db.prepare(`
    SELECT w.*, u.username FROM withdrawals w LEFT JOIN users u ON u.id = w.user_id
    WHERE w.status = 'pending' ORDER BY w.created_at ASC
  `).all();
  res.json({ withdrawals });
});

// GET /api/withdrawals/mine
router.get('/withdrawals/mine', authRequired, (req, res) => {
  const withdrawals = db.prepare(
    'SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC'
  ).all(req.user.id);
  res.json({ withdrawals });
});

// POST /api/withdrawals/request — agent requests (matches frontend)
router.post('/withdrawals/request', authRequired, (req, res) => {
  const { amount_bdt, method, account_name, account_number, note } = req.body || {};
  const amt = Number(amount_bdt);
  const cfg = getPaymentConfig();

  if (!Number.isFinite(amt) || amt < cfg.min_amount || amt > 1_000_000) {
    return res.status(400).json({ error: `Amount must be between ৳${cfg.min_amount} and ৳1,000,000` });
  }
  if (!cfg.methods_enabled.includes(method)) {
    return res.status(400).json({ error: 'Selected payment method is not currently accepted' });
  }
  if (typeof account_number !== 'string' || account_number.trim().length < 3 || account_number.length > 100) {
    return res.status(400).json({ error: 'Account number must be 3-100 chars' });
  }
  if (account_name && (typeof account_name !== 'string' || account_name.length > 120)) {
    return res.status(400).json({ error: 'Invalid account name' });
  }
  if (note && (typeof note !== 'string' || note.length > 500)) {
    return res.status(400).json({ error: 'Note too long (max 500 chars)' });
  }

  const u = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.user.id);
  if (!u || amt > u.balance) return res.status(400).json({ error: 'Insufficient balance' });

  const existing = db.prepare("SELECT id FROM withdrawals WHERE user_id = ? AND status = 'pending'").get(req.user.id);
  if (existing) return res.status(400).json({ error: 'You already have a pending withdrawal. Wait for admin to process it.' });

  const fee = +(amt * cfg.fee_percent / 100).toFixed(2);
  const noteWithFee = `${note ? note + ' | ' : ''}Fee ${cfg.fee_percent}% = ৳${fee.toFixed(2)} | Net ৳${(amt - fee).toFixed(2)}`;

  const tx = db.transaction(() => {
    const r = db.prepare(`
      INSERT INTO withdrawals (user_id, amount_bdt, method, account_name, account_number, note, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `).run(req.user.id, amt, method, account_name || null, account_number.trim(), noteWithFee);

    // Notify all active admins so they see it in real time on the bell
    const admins = db.prepare("SELECT id FROM users WHERE role = 'admin' AND status = 'active'").all();
    const insertNotif = db.prepare(`
      INSERT INTO notifications (user_id, title, message, type)
      VALUES (?, ?, ?, 'warning')
    `);
    for (const a of admins) {
      insertNotif.run(
        a.id,
        '💰 New Withdrawal Request',
        `${req.user.username} requested ৳${amt.toFixed(2)} via ${method.toUpperCase()}`
      );
    }
    return r.lastInsertRowid;
  });
  const id = tx();

  logFromReq(req, 'withdrawal_request', { targetType: 'withdrawal', targetId: id, meta: { amount: amt, method } });
  res.status(201).json({ id, fee, net: +(amt - fee).toFixed(2) });
});

// POST /api/withdrawals/:id/approve — admin approves AND marks paid (single step)
router.post('/withdrawals/:id/approve', authRequired, adminOnly, (req, res) => {
  const id = +req.params.id;
  const { admin_note } = req.body || {};
  const w = db.prepare("SELECT * FROM withdrawals WHERE id = ? AND status = 'pending'").get(id);
  if (!w) return res.status(404).json({ error: 'Not found or already processed' });

  const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(w.user_id);
  if (!user || user.balance < w.amount_bdt) return res.status(400).json({ error: 'User has insufficient balance' });

  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(w.amount_bdt, w.user_id);
    db.prepare(
      "UPDATE withdrawals SET status = 'approved', processed_at = strftime('%s','now'), admin_note = ?, reviewed_by = ?, reviewed_at = strftime('%s','now') WHERE id = ?"
    ).run(admin_note || null, req.user.id, id);
    db.prepare(`
      INSERT INTO payments (user_id, amount_bdt, type, method, reference, note)
      VALUES (?, ?, 'debit', ?, ?, 'Withdrawal approved & paid')
    `).run(w.user_id, w.amount_bdt, w.method, `wd:${id}`);
    db.prepare(`
      INSERT INTO notifications (user_id, title, message, type)
      VALUES (?, ?, ?, 'success')
    `).run(
      w.user_id,
      'Withdrawal Approved ✅',
      `Your withdrawal of ৳${w.amount_bdt.toFixed(2)} via ${w.method} has been processed.${admin_note ? ' Note: ' + admin_note : ''}`
    );
  });
  tx();

  logFromReq(req, 'withdrawal_approved', { targetType: 'withdrawal', targetId: id });
  res.json({ ok: true });
});

// POST /api/withdrawals/:id/reject
router.post('/withdrawals/:id/reject', authRequired, adminOnly, (req, res) => {
  const id = +req.params.id;
  const { admin_note } = req.body || {};
  const w = db.prepare("SELECT * FROM withdrawals WHERE id = ? AND status = 'pending'").get(id);
  if (!w) return res.status(404).json({ error: 'Not found or already processed' });

  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE withdrawals SET status = 'rejected', processed_at = strftime('%s','now'), admin_note = ?, reviewed_by = ?, reviewed_at = strftime('%s','now') WHERE id = ?"
    ).run(admin_note || null, req.user.id, id);
    db.prepare(`
      INSERT INTO notifications (user_id, title, message, type)
      VALUES (?, ?, ?, 'warning')
    `).run(
      w.user_id,
      'Withdrawal Rejected ❌',
      `Your withdrawal of ৳${w.amount_bdt.toFixed(2)} via ${w.method} was rejected.${admin_note ? ` Reason: ${admin_note}` : ''}`
    );
  });
  tx();

  logFromReq(req, 'withdrawal_rejected', { targetType: 'withdrawal', targetId: id });
  res.json({ ok: true });
});

module.exports = router;
