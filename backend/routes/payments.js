const express = require('express');
const db = require('../lib/db');
const { authRequired, adminOnly } = require('../middleware/auth');
const { logFromReq } = require('../lib/audit');

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

// GET /api/withdrawals — admin sees all (filterable)
router.get('/withdrawals', authRequired, adminOnly, (req, res) => {
  const { status } = req.query;
  let q = `SELECT w.*, u.username FROM withdrawals w LEFT JOIN users u ON u.id = w.user_id`;
  const params = [];
  if (status) { q += ' WHERE w.status = ?'; params.push(status); }
  q += ' ORDER BY w.created_at DESC LIMIT 200';
  res.json({ withdrawals: db.prepare(q).all(...params) });
});

// GET /api/withdrawals/mine
router.get('/withdrawals/mine', authRequired, (req, res) => {
  const withdrawals = db.prepare(
    'SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC'
  ).all(req.user.id);
  res.json({ withdrawals });
});

// POST /api/withdrawals — agent requests
router.post('/withdrawals', authRequired, (req, res) => {
  const { amount_bdt, method, account_name, account_number } = req.body || {};
  const amt = +amount_bdt;
  if (!amt || amt <= 0 || !method || !account_number) {
    return res.status(400).json({ error: 'amount_bdt, method, account_number required' });
  }
  if (amt > req.user.balance) return res.status(400).json({ error: 'Insufficient balance' });

  const result = db.prepare(`
    INSERT INTO withdrawals (user_id, amount_bdt, method, account_name, account_number, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `).run(req.user.id, amt, method, account_name || null, account_number);

  logFromReq(req, 'withdrawal_request', { targetType: 'withdrawal', targetId: result.lastInsertRowid });
  res.status(201).json({ id: result.lastInsertRowid });
});

// POST /api/withdrawals/:id/approve — admin
router.post('/withdrawals/:id/approve', authRequired, adminOnly, (req, res) => {
  const id = +req.params.id;
  const w = db.prepare("SELECT * FROM withdrawals WHERE id = ? AND status = 'pending'").get(id);
  if (!w) return res.status(404).json({ error: 'Not found or already processed' });

  const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(w.user_id);
  if (user.balance < w.amount_bdt) return res.status(400).json({ error: 'User has insufficient balance' });

  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(w.amount_bdt, w.user_id);
    db.prepare("UPDATE withdrawals SET status = 'approved', processed_at = strftime('%s','now') WHERE id = ?").run(id);
    db.prepare(`
      INSERT INTO payments (user_id, amount_bdt, type, method, reference, note)
      VALUES (?, ?, 'debit', ?, ?, 'Withdrawal approved')
    `).run(w.user_id, w.amount_bdt, w.method, `wd:${id}`);
    db.prepare(`
      INSERT INTO notifications (user_id, title, message, type)
      VALUES (?, ?, ?, 'success')
    `).run(w.user_id, 'Withdrawal Approved ✅', `Your withdrawal of ৳${w.amount_bdt.toFixed(2)} via ${w.method} has been approved and processed.`);
  });
  tx();

  logFromReq(req, 'withdrawal_approved', { targetType: 'withdrawal', targetId: id });
  res.json({ ok: true });
});

// POST /api/withdrawals/:id/reject
router.post('/withdrawals/:id/reject', authRequired, adminOnly, (req, res) => {
  const id = +req.params.id;
  const { note } = req.body || {};
  const w = db.prepare("SELECT * FROM withdrawals WHERE id = ? AND status = 'pending'").get(id);
  if (!w) return res.status(404).json({ error: 'Not found or already processed' });

  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE withdrawals SET status = 'rejected', processed_at = strftime('%s','now'), admin_note = ? WHERE id = ?"
    ).run(note || null, id);
    db.prepare(`
      INSERT INTO notifications (user_id, title, message, type)
      VALUES (?, ?, ?, 'warning')
    `).run(
      w.user_id,
      'Withdrawal Rejected ❌',
      `Your withdrawal of ৳${w.amount_bdt.toFixed(2)} via ${w.method} was rejected.${note ? ` Reason: ${note}` : ''}`
    );
  });
  tx();

  logFromReq(req, 'withdrawal_rejected', { targetType: 'withdrawal', targetId: id });
  res.json({ ok: true });
});

module.exports = router;
