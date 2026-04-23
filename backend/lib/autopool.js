// Shared auto-pool scheduler — for every registered bot it can:
//   1. periodically call the bot's scrapeNow() to refill its pool
//   2. prune pool numbers older than `ttl_min` minutes that are still
//      'active' with no OTP yet (stale, never claimed)
//   3. cap the pool to `max_size` — when over, oldest unused are released
//
// Each bot has its own settings row in the `settings` table under key
// `autopool:<botId>`, JSON-encoded:
//   { enabled, interval_min, ttl_min, max_size }
// Defaults are applied if the row is missing or partial. A single global
// timer (every 30s) checks "is each bot due to run yet?" — much cheaper
// than one timer per bot, and survives admin updates without restart.

const db = require('./db');

const REGISTRY = new Map(); // botId -> { label, poolUser, scrapeNow }

const DEFAULTS = {
  enabled: false,        // OFF by default — admin opts in per bot
  interval_min: 15,      // refill every 15 min
  ttl_min: 360,          // prune unused numbers older than 6 h
  max_size: 5000,        // soft cap on pool size
};
const LIMITS = {
  interval_min: { min: 1, max: 1440 },   // 1 min .. 24 h
  ttl_min:      { min: 5, max: 10080 },  // 5 min .. 7 days
  max_size:     { min: 50, max: 500000 },
};

function clamp(n, { min, max }) { return Math.max(min, Math.min(max, n)); }

function settingsKey(botId) { return `autopool:${botId}`; }

function getConfig(botId) {
  let cfg = { ...DEFAULTS };
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(settingsKey(botId));
    if (row?.value) {
      const p = JSON.parse(row.value);
      if (typeof p.enabled === 'boolean') cfg.enabled = p.enabled;
      if (Number.isFinite(+p.interval_min)) cfg.interval_min = clamp(+p.interval_min, LIMITS.interval_min);
      if (Number.isFinite(+p.ttl_min))      cfg.ttl_min      = clamp(+p.ttl_min,      LIMITS.ttl_min);
      if (Number.isFinite(+p.max_size))     cfg.max_size     = clamp(+p.max_size,     LIMITS.max_size);
    }
  } catch (_) { /* fall back to defaults */ }
  return cfg;
}

function saveConfig(botId, patch) {
  const cur = getConfig(botId);
  const next = { ...cur };
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  if (Number.isFinite(+patch.interval_min)) next.interval_min = clamp(+patch.interval_min, LIMITS.interval_min);
  if (Number.isFinite(+patch.ttl_min))      next.ttl_min      = clamp(+patch.ttl_min,      LIMITS.ttl_min);
  if (Number.isFinite(+patch.max_size))     next.max_size     = clamp(+patch.max_size,     LIMITS.max_size);
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%s','now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(settingsKey(botId), JSON.stringify(next));
  // Reset the "last run" so an admin who just enabled doesn't have to wait a full cycle.
  STATE.set(botId, { ...(STATE.get(botId) || {}), lastRunAt: 0 });
  return next;
}

// ---- Pool helpers (allocations table is shared by every bot) ----
function poolUserId(username) {
  const u = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  return u?.id || null;
}

function poolStats(botId) {
  const reg = REGISTRY.get(botId);
  if (!reg) return { count: 0 };
  const uid = poolUserId(reg.poolUser);
  if (!uid) return { count: 0 };
  const r = db.prepare(
    `SELECT COUNT(*) AS c FROM allocations
      WHERE user_id = ? AND status = 'active' AND (otp IS NULL OR otp = '')`,
  ).get(uid);
  return { count: r?.c || 0 };
}

function pruneStale(botId, ttlMin) {
  const reg = REGISTRY.get(botId);
  if (!reg) return 0;
  const uid = poolUserId(reg.poolUser);
  if (!uid) return 0;
  const cutoff = Math.floor(Date.now() / 1000) - ttlMin * 60;
  const r = db.prepare(
    `UPDATE allocations SET status = 'released'
      WHERE user_id = ? AND status = 'active'
        AND (otp IS NULL OR otp = '')
        AND allocated_at < ?`,
  ).run(uid, cutoff);
  return r.changes || 0;
}

function capSize(botId, maxSize) {
  const reg = REGISTRY.get(botId);
  if (!reg) return 0;
  const uid = poolUserId(reg.poolUser);
  if (!uid) return 0;
  const cur = poolStats(botId).count;
  const overflow = cur - maxSize;
  if (overflow <= 0) return 0;
  // Release the OLDEST unused entries first.
  const r = db.prepare(
    `UPDATE allocations SET status = 'released'
      WHERE id IN (
        SELECT id FROM allocations
         WHERE user_id = ? AND status = 'active' AND (otp IS NULL OR otp = '')
         ORDER BY allocated_at ASC
         LIMIT ?
      )`,
  ).run(uid, overflow);
  return r.changes || 0;
}

// ---- Registration + scheduler ----
const STATE = new Map(); // botId -> { lastRunAt, lastResult, running }

function register(botId, { label, poolUser, scrapeNow }) {
  REGISTRY.set(botId, { label, poolUser, scrapeNow });
  if (!STATE.has(botId)) STATE.set(botId, { lastRunAt: 0, lastResult: null, running: false });
}

async function runOnce(botId, { force = false } = {}) {
  const reg = REGISTRY.get(botId);
  if (!reg) return { ok: false, error: 'not registered' };
  const cfg = getConfig(botId);
  const st = STATE.get(botId) || { lastRunAt: 0, running: false };
  if (st.running) return { ok: false, error: 'already running' };
  if (!force && !cfg.enabled) return { ok: false, error: 'disabled' };

  st.running = true;
  STATE.set(botId, st);

  const result = { addedRequested: false, scrapeError: null, pruned: 0, capped: 0, poolBefore: 0, poolAfter: 0 };
  result.poolBefore = poolStats(botId).count;

  try {
    if (typeof reg.scrapeNow === 'function') {
      result.addedRequested = true;
      try { await reg.scrapeNow(); }
      catch (e) { result.scrapeError = e?.message || String(e); }
    }
    result.pruned = pruneStale(botId, cfg.ttl_min);
    result.capped = capSize(botId, cfg.max_size);
    result.poolAfter = poolStats(botId).count;
  } finally {
    st.running = false;
    st.lastRunAt = Math.floor(Date.now() / 1000);
    st.lastResult = result;
    STATE.set(botId, st);
  }
  return { ok: true, result };
}

let TICK_TIMER = null;
function tick() {
  const now = Math.floor(Date.now() / 1000);
  for (const botId of REGISTRY.keys()) {
    const cfg = getConfig(botId);
    if (!cfg.enabled) continue;
    const st = STATE.get(botId) || { lastRunAt: 0 };
    if (st.running) continue;
    const due = (now - (st.lastRunAt || 0)) >= cfg.interval_min * 60;
    if (due) {
      runOnce(botId).catch(() => { /* swallow — already recorded in state */ });
    }
  }
}

function startScheduler() {
  if (TICK_TIMER) return;
  TICK_TIMER = setInterval(tick, 30_000);  // poll every 30 s
  // First check shortly after boot so a freshly-enabled bot fires soon
  setTimeout(tick, 5_000);
  console.log('[autopool] scheduler started (30s tick)');
}

function listBots() {
  return Array.from(REGISTRY.entries()).map(([botId, reg]) => {
    const cfg = getConfig(botId);
    const st = STATE.get(botId) || {};
    return {
      botId,
      label: reg.label,
      config: cfg,
      pool: poolStats(botId).count,
      lastRunAt: st.lastRunAt || null,
      lastResult: st.lastResult || null,
      running: !!st.running,
      limits: LIMITS,
      defaults: DEFAULTS,
    };
  });
}

function getBot(botId) {
  if (!REGISTRY.has(botId)) return null;
  const reg = REGISTRY.get(botId);
  const cfg = getConfig(botId);
  const st = STATE.get(botId) || {};
  return {
    botId,
    label: reg.label,
    config: cfg,
    pool: poolStats(botId).count,
    lastRunAt: st.lastRunAt || null,
    lastResult: st.lastResult || null,
    running: !!st.running,
    limits: LIMITS,
    defaults: DEFAULTS,
  };
}

module.exports = {
  register, startScheduler, runOnce,
  getConfig, saveConfig, getBot, listBots,
  DEFAULTS, LIMITS,
};