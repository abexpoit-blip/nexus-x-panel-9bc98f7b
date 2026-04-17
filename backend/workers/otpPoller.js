// Background worker — polls upstream providers for OTP on active allocations
// and credits agents automatically.
const cron = require('node-cron');
const db = require('../lib/db');
const providers = require('../providers');
const { markOtpReceived } = require('../routes/numbers');

const INTERVAL = +(process.env.OTP_POLL_INTERVAL || 5);

let busy = false;

async function pollOnce() {
  if (busy) return;
  busy = true;
  try {
    const pending = db.prepare(`
      SELECT * FROM allocations
      WHERE status = 'active' AND otp IS NULL
        AND provider_ref IS NOT NULL
        AND allocated_at > strftime('%s','now') - 600    -- last 10 min only
      LIMIT 50
    `).all();

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
  // node-cron doesn't support sub-minute cleanly; use setInterval
  setInterval(pollOnce, INTERVAL * 1000);
  console.log(`✓ OTP poller started (every ${INTERVAL}s)`);

  // Every 1 minute: expire stale 'active' allocations (>10 min, no OTP).
  // Agent's balance is NOT touched — number was free; only the slot is released.
  cron.schedule('* * * * *', () => {
    const r = db.prepare(`
      UPDATE allocations SET status = 'expired'
      WHERE status = 'active' AND otp IS NULL
        AND allocated_at < strftime('%s','now') - 600
    `).run();
    if (r.changes) console.log(`[cleanup] expired ${r.changes} allocations (10min timeout)`);
  });
}

module.exports = { start, pollOnce };
