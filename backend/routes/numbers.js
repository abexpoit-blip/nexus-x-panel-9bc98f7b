const express = require('express');
const db = require('../lib/db');
const { authRequired, adminOnly } = require('../middleware/auth');
const { logFromReq } = require('../lib/audit');
const providers = require('../providers');
const { agentPayout } = require('../lib/commission');
const { getOtpExpirySec, getRecentOtpHours } = require('../lib/settings');

const router = express.Router();

// GET /api/numbers/config — config the agent UI needs (OTP expiry for the
// per-number countdown timer). Authed-only so we don't leak settings publicly.
router.get('/config', authRequired, (req, res) => {
  res.json({ otp_expiry_sec: getOtpExpirySec() });
});

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

// GET /api/numbers/msi/ranges — same shape, MSI provider
router.get('/msi/ranges', authRequired, async (req, res) => {
  try {
    const provider = providers.get('msi');
    const ranges = await provider.listRanges();
    res.json({ ranges });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/numbers/get — agent allocates a fresh number
router.post('/get', authRequired, async (req, res) => {
  try {
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

    // Per-request limit — re-read from DB so admin updates apply WITHOUT relogin.
    // Falls back to 100 (was 5) so a missing/zero limit doesn't accidentally cap agents.
    const fresh = db.prepare('SELECT per_request_limit, daily_limit FROM users WHERE id = ?').get(userId);
    const perReq = fresh?.per_request_limit > 0 ? fresh.per_request_limit : 100;
    const requested = Math.min(+count || 1, perReq);

    // Daily limit
    const todayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
    const usedToday = db.prepare(
      "SELECT COUNT(*) c FROM allocations WHERE user_id = ? AND allocated_at >= ?"
    ).get(userId, todayStart).c;
    const dailyLimit = fresh?.daily_limit > 0 ? fresh.daily_limit : 1000;
    if (usedToday >= dailyLimit) {
      return res.status(429).json({ error: `Daily limit reached (${usedToday}/${dailyLimit})` });
    }

    let provider;
    try { provider = providers.get(providerId); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    // Phase 1 — fetch numbers from provider in parallel (with concurrency cap
    // so we don't hammer the upstream / IMS pool with 100 simultaneous gets).
    // For IMS pool (sync DB reads) this completes near-instantly; for AccHub-style
    // remote providers it parallelises network round-trips (10x speedup on bulk).
    const CONCURRENCY = 10;
    const fetchOne = () => provider.getNumber({
      countryId: country_id, operatorId: operator_id,
      countryCode: country_code, operator, range,
    });
    const fetched = []; // [{ ok: true, r } | { ok: false, msg }]
    let cursor = 0;
    async function worker() {
      while (cursor < requested) {
        const myIdx = cursor++;
        try {
          const r = await fetchOne();
          if (!r || !r.phone_number) fetched[myIdx] = { ok: false, msg: 'Provider returned no number' };
          else fetched[myIdx] = { ok: true, r };
        } catch (e) {
          const msg = e?.response?.data?.message
                    || (typeof e?.response?.data === 'string' ? e.response.data : null)
                    || e?.message || 'Unknown provider error';
          fetched[myIdx] = { ok: false, msg };
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, requested) }, worker));

    // Phase 2 — atomically write ALL allocations in ONE DB transaction.
    // Was: sequential per-number INSERT/UPDATE (slow + partial-failure risky on burst).
    // Now: single transaction commits 100 allocations in <10ms.
    const allocated = [];
    const errors = [];
    const upPool = db.prepare(`UPDATE allocations SET user_id=?, status='active', allocated_at=strftime('%s','now') WHERE id=?`);
    const insAlloc = db.prepare(`
      INSERT INTO allocations (user_id, provider, provider_ref, phone_number, operator, country_code, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `);
    const writeAll = db.transaction(() => {
      for (const f of fetched) {
        if (!f) { errors.push('Provider returned no number'); continue; }
        if (!f.ok) { errors.push(f.msg); continue; }
        const r = f.r;
        let id;
        if (r.__pool_id) {
          upPool.run(userId, r.__pool_id);
          id = r.__pool_id;
        } else {
          const result = insAlloc.run(userId, providerId, r.provider_ref || null, r.phone_number, r.operator || null, r.country_code || null);
          id = result.lastInsertRowid;
        }
        allocated.push({ id, phone_number: r.phone_number, operator: r.operator, otp: null, status: 'active' });
      }
    });
    writeAll();

    logFromReq(req, 'allocation', { meta: { provider: providerId, count: allocated.length, errors: errors.length, errorDetails: errors.slice(0, 3) } });
    res.json({ allocated, errors });
  } catch (fatal) {
    // Final safety net — don't let ANY exception bubble up as 500
    console.error('[/numbers/get] fatal:', fatal);
    res.status(500).json({ error: fatal?.message || 'Internal error', allocated: [], errors: [fatal?.message || 'Internal error'] });
  }
});

// GET /api/numbers/my — agent's "live" working list:
//   • status='active'   → always shown
//   • status='received' → only within the admin-configured "recent OTP" window
// Older successful OTPs are still queryable via GET /api/numbers/history.
router.get('/my', authRequired, (req, res) => {
  const recentHours = getRecentOtpHours();
  const cutoff = Math.floor(Date.now() / 1000) - recentHours * 3600;
  const numbers = db.prepare(`
    SELECT id, phone_number, operator, country_code, otp, status, allocated_at, otp_received_at
    FROM allocations
    WHERE user_id = ?
      AND (
        status = 'active'
        OR (status = 'received' AND otp_received_at >= ?)
      )
    ORDER BY allocated_at DESC LIMIT 200
  `).all(req.user.id, cutoff);
  res.json({ numbers, recent_window_hours: recentHours });
});

// GET /api/numbers/history — paginated, searchable history of ALL successful
// OTPs ever delivered to this agent. Pulled from the CDR table so it survives
// even if the underlying allocation row is later purged by admin cleanup.
//
// Query params:
//   page, page_size       — pagination (default 1 / 50, max 200)
//   q                     — substring search across phone / otp / operator
//   from, to              — unix-second range filter on created_at
//                           OR ISO date strings (YYYY-MM-DD); 'to' is inclusive
//   format=csv            — stream CSV download (ignores pagination, max 50k)
router.get('/history', authRequired, (req, res) => {
  const page = Math.max(1, +(req.query.page) || 1);
  const pageSize = Math.max(1, Math.min(200, +(req.query.page_size) || 50));
  const q = (req.query.q || '').toString().trim();
  const isCsv = (req.query.format || '').toString().toLowerCase() === 'csv';

  // Accept unix seconds OR YYYY-MM-DD. Empty → no bound.
  const parseTs = (v, endOfDay = false) => {
    if (v === undefined || v === null || v === '') return null;
    const s = String(v).trim();
    if (/^\d+$/.test(s)) return +s;
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(s)) d.setHours(23, 59, 59, 999);
    return Math.floor(d.getTime() / 1000);
  };
  const fromTs = parseTs(req.query.from, false);
  const toTs = parseTs(req.query.to, true);

  const where = ["user_id = ?", "status = 'billed'"];
  const params = [req.user.id];
  if (q) {
    where.push("(phone_number LIKE ? OR otp_code LIKE ? OR operator LIKE ?)");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (fromTs !== null) { where.push("created_at >= ?"); params.push(fromTs); }
  if (toTs !== null) { where.push("created_at <= ?"); params.push(toTs); }
  const whereSql = where.join(' AND ');

  // Download branch — stream up to 50k rows in plain `Number|OTP` format
  // (one entry per line). Matches the agent's GetNumber page download so the
  // same import scripts work everywhere. We keep the `format=csv` query name
  // for backward compatibility with the UI button wiring.
  if (isCsv) {
    const rows = db.prepare(`
      SELECT phone_number, otp_code
      FROM cdr WHERE ${whereSql}
      ORDER BY created_at DESC LIMIT 50000
    `).all(...params);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="otp-history-${new Date().toISOString().slice(0,10)}.txt"`);
    for (const r of rows) {
      if (!r.phone_number) continue;
      res.write(r.otp_code ? `${r.phone_number}|${r.otp_code}\n` : `${r.phone_number}\n`);
    }
    return res.end();
  }

  const total = db.prepare(`SELECT COUNT(*) c FROM cdr WHERE ${whereSql}`).get(...params).c;
  const rows = db.prepare(`
    SELECT id, allocation_id, country_code, operator, phone_number, otp_code, cli,
           price_bdt, created_at
    FROM cdr
    WHERE ${whereSql}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, (page - 1) * pageSize);

  const agg = db.prepare(`
    SELECT COUNT(*) c, COALESCE(SUM(price_bdt),0) s
    FROM cdr WHERE ${whereSql}
  `).get(...params);

  res.json({
    rows,
    page,
    page_size: pageSize,
    total,
    total_pages: Math.max(1, Math.ceil(total / pageSize)),
    summary: { count: agg.c, earnings_bdt: +(+agg.s).toFixed(2) },
  });
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

// GET /api/numbers/summary — REAL agent stats
//   c = number of SUCCESSFUL OTPs (billed CDRs) in window
//   s = total earnings (BDT) credited in that window
router.get('/summary', authRequired, (req, res) => {
  const u = req.user.id;
  const todayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
  const weekStart = todayStart - 7 * 86400;
  const monthStart = todayStart - 30 * 86400;
  const cnt = (since) => {
    const r = db.prepare(
      "SELECT COUNT(*) c, COALESCE(SUM(price_bdt),0) s FROM cdr WHERE user_id=? AND status='billed' AND created_at >= ?"
    ).get(u, since);
    return { c: r.c, s: +(+r.s).toFixed(2) };
  };
  // Average OTP wait time = avg(otp_received_at - allocated_at) in seconds
  // Calculated over allocations where OTP actually arrived. We expose three windows:
  //   today / week / month + an all-time number for stability when buckets are small.
  const avgWait = (since) => {
    const r = db.prepare(`
      SELECT
        COALESCE(AVG(otp_received_at - allocated_at), 0) AS avg_sec,
        COALESCE(MIN(otp_received_at - allocated_at), 0) AS min_sec,
        COALESCE(MAX(otp_received_at - allocated_at), 0) AS max_sec,
        COUNT(*) AS samples
      FROM allocations
      WHERE user_id = ?
        AND status = 'received'
        AND otp_received_at IS NOT NULL
        AND allocated_at IS NOT NULL
        AND otp_received_at >= allocated_at
        AND otp_received_at >= ?
    `).get(u, since);
    return {
      avg_sec: Math.round(r.avg_sec || 0),
      min_sec: Math.round(r.min_sec || 0),
      max_sec: Math.round(r.max_sec || 0),
      samples: r.samples || 0,
    };
  };

  res.json({
    today: cnt(todayStart),
    week: cnt(weekStart),
    month: cnt(monthStart),
    active: db.prepare("SELECT COUNT(*) c FROM allocations WHERE user_id=? AND status='active'").get(u).c,
    wait_time: {
      today: avgWait(todayStart),
      week: avgWait(weekStart),
      month: avgWait(monthStart),
      all_time: avgWait(0),
    },
  });
});

// =============================================================
// IMS MANUAL endpoints (admin only)
// =============================================================

// POST /api/numbers/ims/pool — admin adds numbers from IMS manager (paste-list)
router.post('/ims/pool', authRequired, adminOnly, (req, res) => {
  const { numbers, country_code, operator, range } = req.body || {};
  const rangeName = (range || operator || '').toString().trim();
  if (!Array.isArray(numbers) || !numbers.length) return res.status(400).json({ error: 'numbers[] required' });
  if (!rangeName) return res.status(400).json({ error: 'range name required' });

  let sysUser = db.prepare("SELECT id FROM users WHERE username = '__ims_pool__'").get();
  if (!sysUser) {
    const r = db.prepare(`INSERT INTO users (username, password_hash, role, status) VALUES ('__ims_pool__', '!', 'agent', 'suspended')`).run();
    sysUser = { id: r.lastInsertRowid };
  }

  const exists = db.prepare(`
    SELECT 1 FROM allocations WHERE provider='ims' AND phone_number=? AND status IN ('pool','active')
  `);
  const insert2 = db.prepare(`
    INSERT INTO allocations (user_id, provider, phone_number, country_code, operator, status, allocated_at)
    VALUES (?, 'ims', ?, ?, ?, 'pool', strftime('%s','now'))
  `);

  let added = 0, skipped = 0, invalid = 0;
  const tx = db.transaction((arr) => {
    for (const n of arr) {
      let phone = (typeof n === 'string' ? n : n?.phone_number || '').toString().trim();
      // strip non-digit / leading +
      phone = phone.replace(/[^\d+]/g, '').replace(/^\++/, '+');
      if (!phone || phone.replace(/\D/g, '').length < 6) { invalid++; continue; }
      if (exists.get(phone)) { skipped++; continue; }
      insert2.run(sysUser.id, phone, country_code || null, rangeName);
      added++;
    }
  });
  tx(numbers);
  logFromReq(req, 'ims_pool_added', { meta: { added, skipped, invalid, range: rangeName } });
  res.json({ added, skipped, invalid, range: rangeName });
});

// =============================================================
// MSI MANUAL endpoints (admin only) — mirror of IMS paste-pool
// =============================================================

// POST /api/numbers/msi/pool — admin adds numbers manually to MSI pool
router.post('/msi/pool', authRequired, adminOnly, (req, res) => {
  const { numbers, country_code, operator, range } = req.body || {};
  const rangeName = (range || operator || '').toString().trim();
  if (!Array.isArray(numbers) || !numbers.length) return res.status(400).json({ error: 'numbers[] required' });
  if (!rangeName) return res.status(400).json({ error: 'range name required' });

  let sysUser = db.prepare("SELECT id FROM users WHERE username = '__msi_pool__'").get();
  if (!sysUser) {
    const r = db.prepare(`INSERT INTO users (username, password_hash, role, status) VALUES ('__msi_pool__', '!', 'agent', 'suspended')`).run();
    sysUser = { id: r.lastInsertRowid };
  }

  const exists = db.prepare(`
    SELECT 1 FROM allocations WHERE provider='msi' AND phone_number=? AND status IN ('pool','active')
  `);
  const insertMsi = db.prepare(`
    INSERT INTO allocations (user_id, provider, phone_number, country_code, operator, status, allocated_at)
    VALUES (?, 'msi', ?, ?, ?, 'pool', strftime('%s','now'))
  `);

  let added = 0, skipped = 0, invalid = 0;
  const tx = db.transaction((arr) => {
    for (const n of arr) {
      let phone = (typeof n === 'string' ? n : n?.phone_number || '').toString().trim();
      phone = phone.replace(/[^\d+]/g, '').replace(/^\++/, '+');
      if (!phone || phone.replace(/\D/g, '').length < 6) { invalid++; continue; }
      if (exists.get(phone)) { skipped++; continue; }
      insertMsi.run(sysUser.id, phone, country_code || null, rangeName);
      added++;
    }
  });
  tx(numbers);
  logFromReq(req, 'msi_pool_added', { meta: { added, skipped, invalid, range: rangeName } });
  res.json({ added, skipped, invalid, range: rangeName });
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
async function markOtpReceived(allocation, otpCode, cli = null) {
  const { agent_amount } = agentPayout({
    provider: allocation.provider,
    country_code: allocation.country_code,
    operator: allocation.operator,
  });

  const tx = db.transaction(() => {
    // Update allocation (preserve existing cli if a new one isn't provided)
    db.prepare(`
      UPDATE allocations SET otp = ?, cli = COALESCE(?, cli),
             status = 'received', otp_received_at = strftime('%s','now')
      WHERE id = ?
    `).run(otpCode, cli || null, allocation.id);

    // Insert CDR (with CLI tag for service identification)
    db.prepare(`
      INSERT INTO cdr (user_id, allocation_id, provider, country_code, operator, phone_number, otp_code, cli, price_bdt, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'billed')
    `).run(
      allocation.user_id, allocation.id, allocation.provider,
      allocation.country_code, allocation.operator, allocation.phone_number,
      otpCode, cli || null, agent_amount
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

    // Notification — IMS shows short range code (e.g. "TF04 → 458291"),
    // AccHub shows the full operator label. CLI/service shown when known.
    const isIms = allocation.provider === 'ims';
    const shortRange = (s) => {
      if (!s) return '';
      const parts = String(s).trim().split(/\s+/);
      return parts[parts.length - 1] || s;
    };
    const label = isIms ? shortRange(allocation.operator) : (allocation.operator || allocation.country_code || '');
    const cliTag = cli ? `${cli} ` : '';
    const prefix = label ? `[${label}] ` : '';
    const notifMsg = agent_amount > 0
      ? `${cliTag}${prefix}${allocation.phone_number} → ${otpCode} (+৳${agent_amount})`
      : `${cliTag}${prefix}${allocation.phone_number} → ${otpCode} (no commission for this rate)`;
    db.prepare(`
      INSERT INTO notifications (user_id, title, message, type)
      VALUES (?, ?, ?, 'success')
    `).run(allocation.user_id, 'OTP received', notifMsg);
  });
  tx();
}

module.exports = router;
module.exports.markOtpReceived = markOtpReceived;
