const express = require('express');
const db = require('../lib/db');
const { authRequired, adminOnly } = require('../middleware/auth');
const { logFromReq } = require('../lib/audit');

const router = express.Router();

// GET /api/rates — all authenticated users can view
router.get('/', authRequired, (req, res) => {
  const rates = db.prepare('SELECT * FROM rates ORDER BY provider, country_code, operator').all();
  res.json({ rates });
});

router.use(authRequired, adminOnly); // below = admin only (must auth first)

// POST /api/rates
router.post('/', (req, res) => {
  const { provider, country_code, country_name, operator, price_bdt, agent_commission_percent = 60, active = 1 } = req.body || {};
  if (!provider) return res.status(400).json({ error: 'Provider required' });
  const result = db.prepare(`
    INSERT INTO rates (provider, country_code, country_name, operator, price_bdt, agent_commission_percent, active)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(provider, country_code || null, country_name || null, operator || null, +price_bdt || 0, +agent_commission_percent || 0, active ? 1 : 0);
  logFromReq(req, 'rate_created', { targetType: 'rate', targetId: result.lastInsertRowid });
  res.status(201).json({ id: result.lastInsertRowid });
});

// PATCH /api/rates/:id
router.patch('/:id', (req, res) => {
  const id = +req.params.id;
  const allowed = ['provider', 'country_code', 'country_name', 'operator', 'price_bdt', 'agent_commission_percent', 'active'];
  const sets = [], vals = [];
  for (const k of allowed) {
    if (k in req.body) {
      let v = req.body[k];
      // Coerce to SQLite-compatible types (number | string | bigint | buffer | null)
      if (v === undefined) v = null;
      else if (typeof v === 'boolean') v = v ? 1 : 0;
      else if (k === 'price_bdt' || k === 'agent_commission_percent') v = v === null || v === '' ? 0 : Number(v);
      else if (k === 'active') v = v ? 1 : 0;
      else if (typeof v === 'object') v = v === null ? null : String(v);
      sets.push(`${k} = ?`);
      vals.push(v);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'No fields' });
  sets.push("updated_at = strftime('%s','now')");
  vals.push(id);
  db.prepare(`UPDATE rates SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  logFromReq(req, 'rate_updated', { targetType: 'rate', targetId: id });
  res.json({ ok: true });
});

// DELETE /api/rates/:id
router.delete('/:id', (req, res) => {
  const id = +req.params.id;
  db.prepare('DELETE FROM rates WHERE id = ?').run(id);
  logFromReq(req, 'rate_deleted', { targetType: 'rate', targetId: id });
  res.json({ ok: true });
});

module.exports = router;
