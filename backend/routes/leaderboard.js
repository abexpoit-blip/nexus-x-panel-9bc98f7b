// Public leaderboard — accessible to any authenticated user (agents + admins).
// Shows top agents by OTP delivery count. Period filter: 'today' | '7d' | 'all'.
const express = require('express');
const db = require('../lib/db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

// GET /api/leaderboard?period=today|7d|all
router.get('/', authRequired, (req, res) => {
  const period = ['today', '7d', 'all'].includes(req.query.period) ? req.query.period : '7d';
  const now = Math.floor(Date.now() / 1000);
  let since = 0;
  if (period === 'today') {
    // Local "today" — use start of UTC day for simplicity (matches server clock)
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    since = Math.floor(d.getTime() / 1000);
  } else if (period === '7d') {
    since = now - 7 * 24 * 3600;
  }

  // Count OTPs delivered per agent within the period.
  // Use cdr table (one row per delivered OTP) for accurate period counts.
  const rows = db.prepare(`
    SELECT u.id,
      COALESCE(NULLIF(u.full_name, ''), u.username) AS username,
      COUNT(c.id) AS otp_count,
      COALESCE(SUM(c.price_bdt), 0) AS earnings_bdt
    FROM users u
    LEFT JOIN cdr c ON c.user_id = u.id
      AND c.status IN ('billed', 'delivered', 'received')
      AND (c.otp_code IS NOT NULL AND c.otp_code != '')
      ${since ? 'AND c.created_at >= ?' : ''}
    WHERE u.role = 'agent'
      AND (u.status = 'active' OR u.username = '__fake_broadcast__')
    GROUP BY u.id
    HAVING otp_count > 0
    ORDER BY otp_count DESC, earnings_bdt DESC
    LIMIT 10
  `).all(...(since ? [since] : []));

  res.json({ leaderboard: rows, period });
});

module.exports = router;
