// Tiny helper used by bots + numbers route to write to otp_audit_log.
// Keeps the schema knowledge in one place + swallows errors so a logging
// failure NEVER breaks an OTP delivery.
const db = require('./db');

function logOtpEvent(row) {
  try {
    db.prepare(`
      INSERT INTO otp_audit_log
        (provider, event, user_id, allocation_id, phone_number, otp_code,
         rows_seen, matches_found, endpoint, currency, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(row.provider || 'unknown'),
      String(row.event || 'unknown'),
      row.user_id ?? null,
      row.allocation_id ?? null,
      row.phone_number ?? null,
      row.otp_code ?? null,
      row.rows_seen ?? null,
      row.matches_found ?? null,
      row.endpoint ?? null,
      row.currency ?? null,
      row.detail ?? null,
    );
  } catch (e) {
    // Don't crash callers — audit is best-effort
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[otp-audit] log failed:', e.message);
    }
  }
}

// Cap retention so the table doesn't grow unbounded on busy days.
// Keeps most recent ~14 days. Called opportunistically.
let _lastTrim = 0;
function trimIfDue() {
  const now = Math.floor(Date.now() / 1000);
  if (now - _lastTrim < 3600) return; // at most once per hour
  _lastTrim = now;
  try {
    db.prepare(`DELETE FROM otp_audit_log WHERE ts < strftime('%s','now') - 1209600`).run();
  } catch (_) { /* ignore */ }
}

module.exports = { logOtpEvent, trimIfDue };