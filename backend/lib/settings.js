// Shared settings helpers — reads from `settings` table with safe fallbacks.
const db = require('./db');

// ---- OTP expiry (how long an allocation stays "active") ----
const OTP_EXPIRY_KEY = 'otp_expiry_sec';
const OTP_EXPIRY_DEFAULT = 480;   // 8 minutes (legacy default)
const OTP_EXPIRY_MIN = 300;       // 5 minutes
const OTP_EXPIRY_MAX = 1800;      // 30 minutes

function getOtpExpirySec() {
  try {
    const v = +(db.prepare('SELECT value FROM settings WHERE key = ?').get(OTP_EXPIRY_KEY)?.value || 0);
    if (!Number.isFinite(v) || v <= 0) return OTP_EXPIRY_DEFAULT;
    return Math.max(OTP_EXPIRY_MIN, Math.min(OTP_EXPIRY_MAX, Math.floor(v)));
  } catch (_) {
    return OTP_EXPIRY_DEFAULT;
  }
}

// ---- Recent-OTP window (how long received OTPs stay on the agent's
//      "live" /numbers/my list before disappearing into history). ----
// Older items remain visible permanently on the dedicated /agent/history page.
const RECENT_OTP_HOURS_KEY = 'recent_otp_hours';
const RECENT_OTP_HOURS_DEFAULT = 24;
const RECENT_OTP_HOURS_MIN = 1;
const RECENT_OTP_HOURS_MAX = 168;   // 7 days

function getRecentOtpHours() {
  try {
    const v = +(db.prepare('SELECT value FROM settings WHERE key = ?').get(RECENT_OTP_HOURS_KEY)?.value || 0);
    if (!Number.isFinite(v) || v <= 0) return RECENT_OTP_HOURS_DEFAULT;
    return Math.max(RECENT_OTP_HOURS_MIN, Math.min(RECENT_OTP_HOURS_MAX, Math.floor(v)));
  } catch (_) {
    return RECENT_OTP_HOURS_DEFAULT;
  }
}

module.exports = {
  getOtpExpirySec,
  OTP_EXPIRY_KEY,
  OTP_EXPIRY_DEFAULT,
  OTP_EXPIRY_MIN,
  OTP_EXPIRY_MAX,
  getRecentOtpHours,
  RECENT_OTP_HOURS_KEY,
  RECENT_OTP_HOURS_DEFAULT,
  RECENT_OTP_HOURS_MIN,
  RECENT_OTP_HOURS_MAX,
};
