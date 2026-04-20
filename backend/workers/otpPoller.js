// Background worker — polls upstream providers for OTP on active allocations
// and credits agents automatically.
const cron = require('node-cron');
const db = require('../lib/db');
const providers = require('../providers');
const { markOtpReceived } = require('../routes/numbers');
const { getOtpExpirySec } = require('../lib/settings');

const INTERVAL = +(process.env.OTP_POLL_INTERVAL || 5);

let busy = false;

async function pollOnce() {
  if (busy) return;
  busy = true;
  try {
    // "Recent" window for upstream polling = current OTP expiry (admin-configurable).
    const expirySec = getOtpExpirySec();
    const pending = db.prepare(`
      SELECT * FROM allocations
      WHERE status = 'active' AND otp IS NULL
        AND provider_ref IS NOT NULL
        AND allocated_at > strftime('%s','now') - ?
      LIMIT 50
    `).all(expirySec);

    for (const a of pending) {
      try {
        const provider = providers.get(a.provider);
        if (provider.mode !== 'auto') continue;  // skip manual providers (IMS)
        const { otp } = await provider.checkOtp(a.provider_ref);
        if (otp) {
          await markOtpReceived(a, otp);
          console.log(`[poller] OTP received: alloc#${a.id} ${a.phone_number} → ${otp}`);
        }
      } catch (e) {
        // Silent — provider down or rate-limited; will retry next tick
      }
    }
  } finally {
    busy = false;
  }
}

function start() {
  setInterval(pollOnce, INTERVAL * 1000);
  if (process.env.NODE_ENV !== 'production') {
    console.log(`✓ OTP poller started (every ${INTERVAL}s)`);
  }

  // Every 1 minute: expire stale 'active' allocations past the configured
  // OTP expiry window. Window matches the agent UI countdown — after that the
  // number is released back so other agents can pick it up. OTPs arriving
  // AFTER expiry are NOT credited (the allocation is no longer 'active').
  // Admin can change the window (5-30 min) via /api/admin/otp-expiry.
  cron.schedule('* * * * *', () => {
    const expirySec = getOtpExpirySec();
    // Safety floor: NEVER expire allocations younger than 60s, even if admin
    // misconfigures the window. Prevents the "instant expired" race where a
    // fresh allocation gets killed before the agent can react.
    const effectiveSec = Math.max(60, expirySec);
    const r = db.prepare(`
      UPDATE allocations SET status = 'expired'
      WHERE status = 'active' AND otp IS NULL
        AND allocated_at < strftime('%s','now') - ?
    `).run(effectiveSec);
    if (r.changes) console.log(`[cleanup] expired ${r.changes} allocations (${Math.round(effectiveSec/60)}min timeout)`);
  });
}

module.exports = { start, pollOnce };
