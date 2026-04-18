const express = require('express');
const db = require('../lib/db');
const { authRequired, adminOnly } = require('../middleware/auth');
const { logFromReq } = require('../lib/audit');

const router = express.Router();

// GET /api/cdr — admin sees all
router.get('/', authRequired, adminOnly, (req, res) => {
  const cdr = db.prepare(`
    SELECT c.*, u.username FROM cdr c
    LEFT JOIN users u ON u.id = c.user_id
    ORDER BY c.created_at DESC LIMIT 1000
  `).all();
  res.json({ cdr });
});

// GET /api/cdr/mine — agent sees own
router.get('/mine', authRequired, (req, res) => {
  const cdr = db.prepare(`
    SELECT * FROM cdr WHERE user_id = ?
    ORDER BY created_at DESC LIMIT 500
  `).all(req.user.id);
  res.json({ cdr });
});

// GET /api/cdr/feed — PUBLIC activity feed (any logged-in agent)
// Shows every OTP that hits the system, with phone + OTP MASKED so no agent
// can steal another agent's codes. Purpose: agents can see which ranges are
// actively receiving OTPs right now and pick hot ranges in Get Number.
router.get('/feed', authRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT id, phone_number, otp_code, operator, country_code,
           provider, price_bdt, created_at
    FROM cdr
    WHERE otp_code IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 200
  `).all();
  // Mask sensitive bits before sending — server-side, so the raw OTP never
  // leaves the box for non-owners.
  const feed = rows.map(r => ({
    id: r.id,
    phone_masked: r.phone_number
      ? r.phone_number.slice(0, 6) + 'X'.repeat(Math.max(0, r.phone_number.length - 6))
      : '',
    otp_length: r.otp_code ? r.otp_code.length : 0,
    operator: r.operator,
    country_code: r.country_code,
    provider: r.provider,
    created_at: r.created_at,
  }));
  res.json({ feed });
});

// POST /api/cdr/refund/:id — admin reverses a billed CDR
router.post('/refund/:id', authRequired, adminOnly, (req, res) => {
  const id = +req.params.id;
  const { note } = req.body || {};
  const c = db.prepare("SELECT * FROM cdr WHERE id = ? AND status = 'billed'").get(id);
  if (!c) return res.status(404).json({ error: 'CDR not found or already processed' });

  const tx = db.transaction(() => {
    db.prepare("UPDATE cdr SET status = 'refunded', note = ? WHERE id = ?").run(note || null, id);
    db.prepare("UPDATE users SET balance = balance - ?, otp_count = MAX(0, otp_count - 1) WHERE id = ?")
      .run(c.price_bdt, c.user_id);
    db.prepare(`
      INSERT INTO payments (user_id, amount_bdt, type, method, reference, note)
      VALUES (?, ?, 'debit', 'admin', ?, ?)
    `).run(c.user_id, c.price_bdt, `refund:${id}`, note || 'OTP refund');
  });
  tx();

  logFromReq(req, 'cdr_refunded', { targetType: 'cdr', targetId: id });
  res.json({ ok: true });
});

module.exports = router;
