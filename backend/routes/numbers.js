const express = require('express');
const db = require('../lib/db');
const { authRequired, adminOnly } = require('../middleware/auth');
const { logFromReq } = require('../lib/audit');
const providers = require('../providers');
const { agentPayout } = require('../lib/commission');

const router = express.Router();

// GET /api/numbers/providers
router.get('/providers', authRequired, (req, res) => {
  res.json({ providers: providers.list() });
});

// GET /api/numbers/countries/:provider
router.get('/countries/:provider', authRequired, async (req, res) => {
  try {
    const provider = providers.get(req.params.provider);
    const countries = await provider.listCountries();
    res.json({ countries });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/numbers/operators/:provider/:countryId
router.get('/operators/:provider/:countryId', authRequired, async (req, res) => {
  try {
    const provider = providers.get(req.params.provider);
    const operators = await provider.listOperators(req.params.countryId);
    res.json({ operators });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/numbers/ims/ranges — agent-facing list of available ranges (with counts)
router.get('/ims/ranges', authRequired, async (req, res) => {
  try {
    const provider = providers.get('ims');
    const ranges = await provider.listRanges();
    res.json({ ranges });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/numbers/get — agent allocates a fresh number
router.post('/get', authRequired, async (req, res) => {
  const { provider: providerId, country_id, operator_id, country_code, operator, range, count = 1 } = req.body || {};
  const userId = req.user.id;

  // Block when maintenance mode is on (admins bypass)
  if (req.user.role !== 'admin') {
    const m = db.prepare("SELECT value FROM settings WHERE key = 'maintenance_mode'").get();
    if (m?.value === 'true') {
      const msg = db.prepare("SELECT value FROM settings WHERE key = 'maintenance_message'").get();
      return res.status(503).json({ error: msg?.value || 'System is under maintenance' });
    }
  }

  // Per-request limit
  const perReq = req.user.per_request_limit || 5;
  const requested = Math.min(+count || 1, perReq);

  // Daily limit
  const todayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
  const usedToday = db.prepare(
    "SELECT COUNT(*) c FROM allocations WHERE user_id = ? AND allocated_at >= ?"
  ).get(userId, todayStart).c;
  if (usedToday >= req.user.daily_limit) {
    return res.status(429).json({ error: 'Daily limit reached' });
  }

  let provider;
  try { provider = providers.get(providerId); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  const allocated = [];
  const errors = [];
  for (let i = 0; i < requested; i++) {
    try {
      const r = await provider.getNumber({ countryId: country_id, operatorId: operator_id, countryCode: country_code, operator, range });
      // Insert/upgrade allocation
      let id;
      if (r.__pool_id) {
        // IMS manual pool — flip status from 'pool' to 'active' for this user
        db.prepare(`UPDATE allocations SET user_id=?, status='active', allocated_at=strftime('%s','now') WHERE id=?`)
          .run(userId, r.__pool_id);
        id = r.__pool_id;
      } else {
        const result = db.prepare(`
          INSERT INTO allocations (user_id, provider, provider_ref, phone_number, operator, country_code, status)
          VALUES (?, ?, ?, ?, ?, ?, 'active')
        `).run(userId, providerId, r.provider_ref, r.phone_number, r.operator, r.country_code);
        id = result.lastInsertRowid;
      }
      allocated.push({ id, phone_number: r.phone_number, operator: r.operator, otp: null, status: 'active' });
    } catch (e) {
      errors.push(e.message);
    }
  }

  logFromReq(req, 'allocation', { meta: { provider: providerId, count: allocated.length, errors: errors.length } });
  res.json({ allocated, errors });
});

// GET /api/numbers/my — agent's own numbers (provider name hidden from agents)
router.get('/my', authRequired, (req, res) => {
  const numbers = db.prepare(`
    SELECT id, phone_number, operator, country_code, otp, status, allocated_at, otp_received_at
    FROM allocations
    WHERE user_id = ? AND status IN ('active','received')
    ORDER BY allocated_at DESC LIMIT 200
  `).all(req.user.id);
  res.json({ numbers });
});

// POST /api/numbers/release/:id
router.post('/release/:id', authRequired, async (req, res) => {
  const id = +req.params.id;
  const a = db.prepare("SELECT * FROM allocations WHERE id = ? AND user_id = ?").get(id, req.user.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  try {
    const provider = providers.get(a.provider);
    if (a.provider_ref) await provider.releaseNumber(a.provider_ref);
  } catch (_) {}
  db.prepare("UPDATE allocations SET status = 'released' WHERE id = ?").run(id);
  res.json({ ok: true });
});

// POST /api/numbers/sync — agent triggers manual OTP poll for their pending numbers
router.post('/sync', authRequired, async (req, res) => {
  const pending = db.prepare(
    "SELECT * FROM allocations WHERE user_id = ? AND status = 'active' AND otp IS NULL"
  ).all(req.user.id);

  let updated = 0;
  for (const a of pending) {
    try {
      const provider = providers.get(a.provider);
      const { otp } = await provider.checkOtp(a.provider_ref);
      if (otp) {
        await markOtpReceived(a, otp);
        updated++;
      }
    } catch (_) {}
  }
  res.json({ updated, pending: pending.length });
});

// POST /api/numbers/summary — agent stats for "My Numbers" dashboard
router.get('/summary', authRequired, (req, res) => {
  const u = req.user.id;
  const todayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
  const weekStart = todayStart - 7 * 86400;
  const monthStart = todayStart - 30 * 86400;
  const cnt = (since) => ({
    c: db.prepare("SELECT COUNT(*) c FROM allocations WHERE user_id=? AND allocated_at >= ?").get(u, since).c,
    s: db.prepare("SELECT COUNT(*) c FROM allocations WHERE user_id=? AND otp IS NOT NULL AND otp_received_at >= ?").get(u, since).c,
  });
  res.json({
    today: cnt(todayStart),
    week: cnt(weekStart),
    month: cnt(monthStart),
    active: db.prepare("SELECT COUNT(*) c FROM allocations WHERE user_id=? AND status='active'").get(u).c,
  });
});

// =============================================================
// IMS MANUAL endpoints (admin only)
// =============================================================

// POST /api/numbers/ims/pool — admin adds numbers from IMS manager
router.post('/ims/pool', authRequired, adminOnly, (req, res) => {
  const { numbers, country_code, operator } = req.body || {};
  if (!Array.isArray(numbers) || !numbers.length) return res.status(400).json({ error: 'numbers[] required' });

  let sysUser = db.prepare("SELECT id FROM users WHERE username = '__ims_pool__'").get();
  if (!sysUser) {
    const r = db.prepare(`INSERT INTO users (username, password_hash, role, status) VALUES ('__ims_pool__', '!', 'agent', 'suspended')`).run();
    sysUser = { id: r.lastInsertRowid };
  }
  const insert2 = db.prepare(`
    INSERT INTO allocations (user_id, provider, phone_number, country_code, operator, status, allocated_at)
    VALUES (?, 'ims', ?, ?, ?, 'pool', strftime('%s','now'))
  `);
  let added = 0;
  const tx = db.transaction((arr) => {
    for (const n of arr) {
      const phone = typeof n === 'string' ? n : n.phone_number;
      if (!phone) continue;
      insert2.run(sysUser.id, phone, country_code || null, operator || null);
      added++;
    }
  });
  tx(numbers);
  logFromReq(req, 'ims_pool_added', { meta: { added, country_code } });
  res.json({ added });
});

// POST /api/numbers/ims/otp — admin pushes received OTP for an IMS number
router.post('/ims/otp', authRequired, adminOnly, async (req, res) => {
  const { phone_number, otp } = req.body || {};
  if (!phone_number || !otp) return res.status(400).json({ error: 'phone_number and otp required' });

  const a = db.prepare(`
    SELECT * FROM allocations WHERE provider='ims' AND phone_number=? AND status='active' AND otp IS NULL
    ORDER BY allocated_at DESC LIMIT 1
  `).get(phone_number);
  if (!a) return res.status(404).json({ error: 'No active IMS allocation matches that number' });

  await markOtpReceived(a, otp);
  res.json({ ok: true, allocation_id: a.id, user_id: a.user_id });
});

// =============================================================
// Helper: when an OTP is confirmed, write CDR + credit agent
// =============================================================
async function markOtpReceived(allocation, otpCode) {
  const { agent_amount } = agentPayout({
    provider: allocation.provider,
    country_code: allocation.country_code,
    operator: allocation.operator,
  });

  const tx = db.transaction(() => {
    // Update allocation
    db.prepare(`
      UPDATE allocations SET otp = ?, status = 'received', otp_received_at = strftime('%s','now')
      WHERE id = ?
    `).run(otpCode, allocation.id);

    // Insert CDR
    db.prepare(`
      INSERT INTO cdr (user_id, allocation_id, provider, country_code, operator, phone_number, otp_code, price_bdt, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'billed')
    `).run(
      allocation.user_id, allocation.id, allocation.provider,
      allocation.country_code, allocation.operator, allocation.phone_number,
      otpCode, agent_amount
    );

    // Credit agent (only if rate card allows payout > 0)
    if (agent_amount > 0) {
      db.prepare(`UPDATE users SET balance = balance + ?, otp_count = otp_count + 1 WHERE id = ?`)
        .run(agent_amount, allocation.user_id);

      // Payment record
      db.prepare(`
        INSERT INTO payments (user_id, amount_bdt, type, method, reference, note)
        VALUES (?, ?, 'credit', 'auto', ?, 'OTP commission')
      `).run(allocation.user_id, agent_amount, `otp:${allocation.id}`);
    } else {
      // Still bump otp_count for stats, but no balance change
      db.prepare(`UPDATE users SET otp_count = otp_count + 1 WHERE id = ?`).run(allocation.user_id);
    }

    // Notification (different message when no payout)
    const notifMsg = agent_amount > 0
      ? `${allocation.phone_number} → ${otpCode} (+৳${agent_amount})`
      : `${allocation.phone_number} → ${otpCode} (no commission for this rate)`;
    db.prepare(`
      INSERT INTO notifications (user_id, title, message, type)
      VALUES (?, ?, ?, 'success')
    `).run(allocation.user_id, 'OTP received', notifMsg);
  });
  tx();
}

module.exports = router;
module.exports.markOtpReceived = markOtpReceived;
