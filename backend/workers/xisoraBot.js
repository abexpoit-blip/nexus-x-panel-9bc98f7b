// XISORA Bot — PURE HTTP cookie-session worker. NO Puppeteer, NO captcha, NO rate limit.
//
// Panel: http://94.23.31.29/sms (XISORA Networks LTD AVSMS Pro+)
// Verified live 2026-04-21:
//   POST /sms/signmein              → form-urlencoded {username, password} → 302 → /sms/client/
//   GET  /sms/client/ajax/dt_numbers.php?ftermination=&fclient=&iDisplayLength=N
//        → DataTables JSON: aaData=[ [checkbox, range_name, phone, payterm, allocate, sub, last_used, return], ... ]
//   GET  /sms/client/ajax/dt_reports.php?fdate1=YYYY-MM-DD HH:MM:SS&fdate2=...&iDisplayLength=N&fg=0
//        → DataTables JSON: aaData=[ [datetime, ?, number, cli, currency, payterm, payout, sub, ...payterm, ...payout, sms_text], ... ]
//
// Required env / DB settings:
//   XISORA_ENABLED=true
//   XISORA_BASE_URL=http://94.23.31.29
//   XISORA_USERNAME=mamun33
//   XISORA_PASSWORD=mamun@12aa
//   XISORA_SCRAPE_INTERVAL=4         (OTP poll seconds — min 2)
//   XISORA_NUMBERS_INTERVAL=600      (pool sync seconds, default 10min)

const db = require('../lib/db');
const { markOtpReceived } = require('../routes/numbers');
const http = require('http');
const https = require('https');
const { URL, URLSearchParams } = require('url');

const QUIET = process.env.NODE_ENV === 'production';
const dlog = (...a) => { if (!QUIET) console.log(...a); };
const dwarn = (...a) => { if (!QUIET) console.warn(...a); };

function readSetting(key) {
  try { return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || null; }
  catch (_) { return null; }
}
function normalizeBase(raw) {
  const fallback = 'http://94.23.31.29';
  if (!raw) return fallback;
  let s = String(raw).trim().replace(/\/+$/, '');
  if (!s) return fallback;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `http://${s}`);
    return `${u.protocol}//${u.host}`;
  } catch (_) { return fallback; }
}
function resolveCreds() {
  const dbEnabled = readSetting('xisora_enabled');
  return {
    ENABLED: (dbEnabled !== null ? dbEnabled : (process.env.XISORA_ENABLED || 'false')).toString().toLowerCase() === 'true',
    BASE_URL: normalizeBase(readSetting('xisora_base_url') || process.env.XISORA_BASE_URL),
    USERNAME: readSetting('xisora_username') || process.env.XISORA_USERNAME || '',
    PASSWORD: readSetting('xisora_password') || process.env.XISORA_PASSWORD || '',
  };
}
function resolveOtpInterval() {
  const d = +(readSetting('xisora_otp_interval') || 0);
  const e = +(process.env.XISORA_SCRAPE_INTERVAL || 4);
  return Math.max(2, d > 0 ? d : e);
}
function resolveAutoRestart() {
  const en = readSetting('xisora_autorestart_enabled');
  const iv = +(readSetting('xisora_autorestart_intervals') || 3);
  return {
    enabled: en === '1' || en === 'true',
    intervals: Math.max(2, Math.min(60, Number.isFinite(iv) ? iv : 3)),
  };
}
let _autoRestartInProgress = false;
let _lastAutoRestartTs = 0;
const AUTO_RESTART_COOLDOWN = 60; // seconds — never auto-restart more than once per minute

let { ENABLED, BASE_URL, USERNAME, PASSWORD } = resolveCreds();
let OTP_INTERVAL = resolveOtpInterval();
const NUMBERS_INTERVAL = Math.max(60, +(process.env.XISORA_NUMBERS_INTERVAL || 600));

// In-memory cookie jar (PHPSESSID). Auto re-login on session drop.
let cookieStr = '';        // "PHPSESSID=abc; ..."
let loggedIn = false;
let busy = false;
let otpTimer = null;
let numbersTimer = null;
let _stopped = false;
let emptyStreak = 0;
let lastHeartbeatAt = 0;        // updated every OTP poll cycle (success or fail)
let queueDepth = 0;             // # of active allocations awaiting OTP
let lastSuccessAt = 0;          // last successful poll (for stale detection)

const status = {
  enabled: false,
  running: false,
  loggedIn: false,
  lastLoginAt: null,
  lastScrapeAt: null,
  lastScrapeOk: false,
  lastNumbersScrapeAt: null,
  lastError: null,
  lastErrorAt: null,
  totalScrapes: 0,
  numbersScrapedTotal: 0,
  numbersAddedTotal: 0,
  otpsDeliveredTotal: 0,
  consecFail: 0,
  baseUrl: '',
  otpIntervalSec: 0,
  numbersIntervalSec: 0,
};

const events = [];
function logEvent(level, message, meta) {
  events.unshift({ ts: Math.floor(Date.now() / 1000), level, message, meta: meta || null });
  if (events.length > 30) events.length = 30;
}

function getStatus() {
  try {
    const poolSize = db.prepare("SELECT COUNT(*) c FROM allocations WHERE provider='xisora' AND status='pool'").get().c;
    const claimingSize = db.prepare("SELECT COUNT(*) c FROM allocations WHERE provider='xisora' AND status='claiming'").get().c;
    const activeAssigned = db.prepare("SELECT COUNT(*) c FROM allocations WHERE provider='xisora' AND status='active'").get().c;
    const otpReceived = db.prepare("SELECT COUNT(*) c FROM allocations WHERE provider='xisora' AND status='received'").get().c;
    queueDepth = activeAssigned;
    const now = Math.floor(Date.now() / 1000);
    // "Stale session" = bot is running but no successful poll in the last 3 intervals
    const staleThreshold = Math.max(30, OTP_INTERVAL * 3);
    const sinceLastSuccess = lastSuccessAt ? now - lastSuccessAt : null;
    const staleSession = !!(status.running && lastSuccessAt && sinceLastSuccess > staleThreshold);
    return {
      ...status, poolSize, claimingSize, activeAssigned, otpReceived,
      events: events.slice(),
      otpCacheSize: recentOtpCache.size,
      emptyStreak,
      heartbeatAt: lastHeartbeatAt || null,
      heartbeatAgeSec: lastHeartbeatAt ? now - lastHeartbeatAt : null,
      queueDepth,
      lastSuccessAt: lastSuccessAt || null,
      sinceLastSuccessSec: sinceLastSuccess,
      staleSession,
      staleThresholdSec: staleThreshold,
    };
  } catch (_) {
    return { ...status, poolSize: 0, claimingSize: 0, activeAssigned: 0, otpReceived: 0,
      events: events.slice(), otpCacheSize: 0, emptyStreak,
      heartbeatAt: null, heartbeatAgeSec: null, queueDepth: 0,
      lastSuccessAt: null, sinceLastSuccessSec: null, staleSession: false, staleThresholdSec: 0 };
  }
}

// ---- Low-level HTTP with cookie jar ----
function _request(method, urlStr, { body = null, formData = null, redirect = 'follow' } = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(urlStr); } catch (e) { return reject(e); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 NexusX-XisoraBot/1.0',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    if (cookieStr) headers['Cookie'] = cookieStr;
    let payload = null;
    if (formData) {
      payload = new URLSearchParams(formData).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(payload);
    } else if (body) {
      payload = body;
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = lib.request({
      method,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers,
      timeout: timeoutMs,
    }, (res) => {
      // Capture Set-Cookie → merge into our jar (just name=value pairs)
      const sc = res.headers['set-cookie'];
      if (sc && sc.length) {
        const jar = new Map();
        // Seed from current jar
        for (const pair of cookieStr.split(/;\s*/)) {
          const eq = pair.indexOf('=');
          if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
        }
        for (const c of sc) {
          const first = c.split(';')[0];
          const eq = first.indexOf('=');
          if (eq > 0) jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
        }
        cookieStr = Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
      }
      // Follow redirect once (login → /client/)
      if (redirect === 'follow' && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, urlStr).toString();
        return _request('GET', next, { redirect: 'follow' }, timeoutMs).then(resolve).catch(reject);
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; if (buf.length > 8_000_000) { req.destroy(); reject(new Error('response too large')); } });
      res.on('end', () => resolve({ status: res.statusCode, body: buf, headers: res.headers }));
    });
    req.on('timeout', () => { req.destroy(new Error('http timeout')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ---- Login (no captcha — XISORA uses simple form POST) ----
async function login() {
  if (!USERNAME || !PASSWORD) throw new Error('XISORA credentials not set');
  // Step 1: GET /sms/SignIn to seed PHPSESSID
  cookieStr = ''; // reset jar
  await _request('GET', `${BASE_URL}/sms/SignIn`, { redirect: 'manual' }, 15000);
  if (!cookieStr) throw new Error('Failed to obtain session cookie from /sms/SignIn');
  // Step 2: POST signmein
  const r = await _request('POST', `${BASE_URL}/sms/signmein`, {
    formData: { username: USERNAME, password: PASSWORD },
    redirect: 'manual',
  }, 15000);
  if (![200, 302, 303].includes(r.status)) {
    throw new Error(`Login POST returned HTTP ${r.status}`);
  }
  // Verify by hitting /sms/client/
  const v = await _request('GET', `${BASE_URL}/sms/client/`, { redirect: 'manual' }, 15000);
  if (v.status !== 200 || /SignIn|Enter Credentials/i.test(v.body)) {
    throw new Error('Login failed — credentials rejected (still on SignIn page)');
  }
  loggedIn = true;
  status.loggedIn = true;
  status.lastLoginAt = Math.floor(Date.now() / 1000);
  console.log(`[xisora-bot] ✓ logged in as ${USERNAME}`);
  logEvent('success', `Logged in as ${USERNAME}`);
}

// ---- Scrape My Numbers via dt_numbers.php DataTables endpoint ----
async function scrapeNumbers() {
  const url = `${BASE_URL}/sms/client/ajax/dt_numbers.php?ftermination=&fclient=&iDisplayStart=0&iDisplayLength=10000&sEcho=1`;
  const r = await _request('GET', url, { redirect: 'manual' }, 30000);
  if (r.status !== 200) {
    if (r.status === 302 || /SignIn/i.test(r.body)) { loggedIn = false; status.loggedIn = false; }
    throw new Error(`dt_numbers HTTP ${r.status}`);
  }
  let json;
  try { json = JSON.parse(r.body); } catch (_) {
    if (/SignIn|Enter Credentials/i.test(r.body)) { loggedIn = false; status.loggedIn = false; throw new Error('Session expired'); }
    throw new Error('dt_numbers non-JSON response');
  }
  const rows = Array.isArray(json.aaData) ? json.aaData : [];
  // Columns: [checkbox_html, range_name, phone, payterm_html, allocate_html, subclient, last_used, return_html]
  const out = [];
  const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, '').trim();
  for (const cells of rows) {
    if (!Array.isArray(cells) || cells.length < 3) continue;
    const range = stripTags(cells[1]);
    const phoneRaw = stripTags(cells[2]).replace(/[\s+-]/g, '');
    if (!/^\d{8,15}$/.test(phoneRaw)) continue;
    out.push({ phone_number: phoneRaw, operator: range || null });
  }
  return out;
}

// ---- Scrape OTP CDR via dt_reports.php ----
function _fmtDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
async function scrapeOtps() {
  // Rolling 48h window so we never miss an OTP across day boundaries.
  const now = new Date();
  const past = new Date(Date.now() - 48 * 3600 * 1000);
  const fdate1 = _fmtDate(past);
  const fdate2 = _fmtDate(now);
  const qs = new URLSearchParams({
    fdate1, fdate2, ftermination: '', fclient: '', fnum: '', fcli: '',
    fgdate: '0', fgtermination: '0', fgclient: '0', fgnumber: '0', fgcli: '0', fg: '0',
    iDisplayStart: '0', iDisplayLength: '500', sEcho: '1',
  }).toString();
  const url = `${BASE_URL}/sms/client/ajax/dt_reports.php?${qs}`;
  const r = await _request('GET', url, { redirect: 'manual' }, 25000);
  if (r.status !== 200) {
    if (r.status === 302 || /SignIn/i.test(r.body)) { loggedIn = false; status.loggedIn = false; }
    throw new Error(`dt_reports HTTP ${r.status}`);
  }
  let json;
  try { json = JSON.parse(r.body); } catch (_) {
    if (/SignIn|Enter Credentials/i.test(r.body)) { loggedIn = false; status.loggedIn = false; throw new Error('Session expired'); }
    throw new Error('dt_reports non-JSON response');
  }
  const rows = Array.isArray(json.aaData) ? json.aaData : [];
  // Columns observed: [datetime, ?, number, cli, currency, payterm, payout, subclient, sub_payterm, sub_payout, sms_text]
  const out = [];
  for (const cells of rows) {
    if (!Array.isArray(cells) || cells.length < 4) continue;
    const dateStr = String(cells[0] || '').trim();
    const phoneRaw = String(cells[2] || '').replace(/[\s+-]/g, '');
    if (!/^\d{8,15}$/.test(phoneRaw)) continue;
    const cli = cells[3] != null ? String(cells[3]).trim() : null;
    const smsText = String(cells[cells.length - 1] || '').trim();
    if (!smsText) continue;
    const otpMatch = smsText.match(/\b(\d{3,8})\b/);
    if (!otpMatch) continue;
    let dateTs = null;
    if (dateStr) {
      // XISORA returns "YYYY-MM-DD HH:MM:SS" — interpret as UTC (server returns its own TZ but we treat as UTC for stable cmp)
      const t = Date.parse(dateStr.replace(' ', 'T') + 'Z');
      if (!isNaN(t)) dateTs = Math.floor(t / 1000);
    }
    out.push({ phone_number: phoneRaw, otp_code: otpMatch[1], sms_text: smsText, cli, date_str: dateStr, date_ts: dateTs });
  }
  return out;
}

// ---- OTP cache (mirror of numpanel) ----
const recentOtpCache = new Map();
const RECENT_OTP_TTL = 30 * 60;
const MAX_OTPS_PER_PHONE = 5;
function _pruneOldEntries(arr) {
  const now = Math.floor(Date.now() / 1000);
  return arr.filter(e => (now - (e.cachedAt || 0)) < RECENT_OTP_TTL);
}
function getRecentOtpFor(phone) {
  const arr = recentOtpCache.get(phone);
  if (!arr || !arr.length) return null;
  const fresh = _pruneOldEntries(arr);
  if (!fresh.length) { recentOtpCache.delete(phone); return null; }
  if (fresh.length !== arr.length) recentOtpCache.set(phone, fresh);
  return fresh[0];
}
function _addToCache(phone, entry) {
  const existing = recentOtpCache.get(phone) || [];
  const dup = existing.find(e => e.otp_code === entry.otp_code &&
    Math.abs((e.date_ts || 0) - (entry.date_ts || 0)) < 60);
  if (dup) return;
  existing.unshift({ ...entry, cachedAt: Math.floor(Date.now() / 1000) });
  if (existing.length > MAX_OTPS_PER_PHONE) existing.length = MAX_OTPS_PER_PHONE;
  recentOtpCache.set(phone, existing);
}

async function deliverOtps() {
  const otps = await scrapeOtps();
  status.lastScrapeAt = Math.floor(Date.now() / 1000);
  status.totalScrapes++;
  status.lastScrapeOk = true;
  for (const o of otps) _addToCache(o.phone_number, o);
  const active = db.prepare(`
    SELECT id, phone_number, allocated_at FROM allocations
    WHERE provider='xisora' AND status='active' AND otp IS NULL
  `).all();
  if (!active.length) return 0;
  let delivered = 0;
  for (const a of active) {
    const cached = getRecentOtpFor(a.phone_number);
    if (!cached) continue;
    const allocAt = a.allocated_at || 0;
    if (cached.date_ts && cached.date_ts < allocAt - 120) {
      const dup = db.prepare(`SELECT 1 FROM allocations WHERE provider='xisora' AND phone_number=? AND otp=? AND id<>? LIMIT 1`)
        .get(a.phone_number, cached.otp_code, a.id);
      if (dup) continue;
    }
    try {
      await markOtpReceived(a, cached.otp_code, cached.cli || null);
      status.otpsDeliveredTotal++;
      delivered++;
      console.log(`[xisora-bot] OTP delivered: ${a.phone_number} → ${cached.otp_code} (alloc#${a.id})`);
      logEvent('success', `OTP delivered to ${a.phone_number}`, { otp: cached.otp_code, alloc: a.id });
    } catch (e) {
      dwarn(`[xisora-bot] markOtpReceived failed for ${a.phone_number}:`, e.message);
    }
  }
  return delivered;
}

function ensurePoolUser() {
  let u = db.prepare("SELECT id FROM users WHERE username = '__xisora_pool__'").get();
  if (!u) {
    const r = db.prepare(`INSERT INTO users (username, password_hash, role, status) VALUES ('__xisora_pool__', '!', 'agent', 'suspended')`).run();
    u = { id: r.lastInsertRowid };
  }
  return u;
}

async function syncPool() {
  const nums = await scrapeNumbers();
  status.lastNumbersScrapeAt = Math.floor(Date.now() / 1000);
  if (!nums.length) {
    emptyStreak++;
    logEvent('warn', `Number scrape returned 0 rows (empty streak ${emptyStreak})`);
    return { added: 0, removed: 0, kept: 0, scraped: 0 };
  }
  emptyStreak = 0;
  // Apply per-range disable filter — admin can pause a range without deleting it
  const disabledRanges = new Set(
    db.prepare("SELECT range_prefix FROM xisora_range_meta WHERE COALESCE(disabled,0) = 1").all()
      .map(r => r.range_prefix)
  );
  const filteredNums = nums.filter(n => !disabledRanges.has(n.operator || 'Unknown'));
  const skipped = nums.length - filteredNums.length;
  const live = new Set(filteredNums.map(n => n.phone_number));
  const sysUser = ensurePoolUser();
  let added = 0, removed = 0, kept = 0;
  const exists = db.prepare("SELECT 1 FROM allocations WHERE provider='xisora' AND phone_number=? AND status IN ('pool','active','claiming') LIMIT 1");
  const ins = db.prepare(`
    INSERT INTO allocations (user_id, provider, phone_number, country_code, operator, status, allocated_at)
    VALUES (?, 'xisora', ?, ?, ?, 'pool', strftime('%s','now'))
  `);
  const poolRows = db.prepare("SELECT id, phone_number FROM allocations WHERE provider='xisora' AND status='pool'").all();
  const del = db.prepare("DELETE FROM allocations WHERE id = ?");
  const tx = db.transaction(() => {
    for (const n of filteredNums) {
      if (exists.get(n.phone_number)) { kept++; continue; }
      ins.run(sysUser.id, n.phone_number, null, n.operator || null);
      added++;
    }
    for (const r of poolRows) {
      if (!live.has(r.phone_number)) { del.run(r.id); removed++; }
    }
  });
  tx();
  status.numbersScrapedTotal += nums.length;
  status.numbersAddedTotal += added;
  if (added || removed || skipped) logEvent('success', `Pool sync: +${added} added, -${removed} removed, ${kept} kept, ${skipped} skipped (disabled) of ${nums.length} live`);
  return { added, removed, kept, scraped: nums.length };
}

// ---- Run history recorder ----
function recordRun({ kind, startedAt, finishedAt, ok, otps, added, removed, kept, scraped, error, triggeredBy }) {
  try {
    db.prepare(`
      INSERT INTO xisora_runs (kind, started_at, finished_at, duration_ms, ok, otps, added, removed, kept, scraped, error, triggered_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      kind, startedAt, finishedAt,
      Math.max(0, (finishedAt - startedAt) * 1000),
      ok ? 1 : 0,
      otps || 0, added || 0, removed || 0, kept || 0, scraped || 0,
      error || null, triggeredBy || 'admin',
    );
    // Keep table bounded (last 500 runs)
    db.prepare(`DELETE FROM xisora_runs WHERE id NOT IN (SELECT id FROM xisora_runs ORDER BY id DESC LIMIT 500)`).run();
  } catch (e) { dwarn('[xisora-bot] recordRun failed:', e.message); }
}

async function scrapeNow() {
  if (!status.running) return { ok: false, error: 'Bot is not running' };
  if (busy) return { ok: false, error: 'Already scraping' };
  busy = true;
  const startedAt = Math.floor(Date.now() / 1000);
  try {
    if (!loggedIn) await login();
    const before = status.otpsDeliveredTotal;
    await deliverOtps();
    const otps = status.otpsDeliveredTotal - before;
    recordRun({ kind: 'scrape-now', startedAt, finishedAt: Math.floor(Date.now()/1000), ok: true, otps, triggeredBy: 'admin' });
    return { ok: true, otps };
  } catch (e) {
    recordRun({ kind: 'scrape-now', startedAt, finishedAt: Math.floor(Date.now()/1000), ok: false, error: e.message, triggeredBy: 'admin' });
    return { ok: false, error: e.message };
  }
  finally { busy = false; }
}
async function syncLive() {
  if (!status.running) return { ok: false, error: 'Bot is not running' };
  if (busy) return { ok: false, error: 'Already syncing' };
  busy = true;
  const startedAt = Math.floor(Date.now() / 1000);
  try {
    if (!loggedIn) await login();
    logEvent('info', 'Live-sync triggered by admin');
    const r = await syncPool();
    recordRun({ kind: 'sync-live', startedAt, finishedAt: Math.floor(Date.now()/1000), ok: true,
      added: r.added, removed: r.removed, kept: r.kept, scraped: r.scraped, triggeredBy: 'admin' });
    return { ok: true, ...r };
  } catch (e) {
    recordRun({ kind: 'sync-live', startedAt, finishedAt: Math.floor(Date.now()/1000), ok: false, error: e.message, triggeredBy: 'admin' });
    return { ok: false, error: e.message };
  }
  finally { busy = false; }
}

function start() {
  ({ ENABLED, BASE_URL, USERNAME, PASSWORD } = resolveCreds());
  OTP_INTERVAL = resolveOtpInterval();
  status.enabled = ENABLED;
  status.baseUrl = BASE_URL;
  status.otpIntervalSec = OTP_INTERVAL;
  status.numbersIntervalSec = NUMBERS_INTERVAL;
  if (!ENABLED) {
    status.running = false; status.loggedIn = false;
    status.lastError = 'XISORA bot disabled';
    logEvent('warn', 'Start skipped — bot disabled');
    console.log('✗ XISORA bot disabled (set XISORA_ENABLED=true or enable from admin panel)');
    return false;
  }
  if (!USERNAME || !PASSWORD) {
    status.lastError = 'XISORA credentials not set';
    logEvent('error', 'Start skipped — credentials not set');
    return false;
  }
  if (otpTimer) { clearTimeout(otpTimer); otpTimer = null; }
  if (numbersTimer) { clearInterval(numbersTimer); numbersTimer = null; }
  try {
    const r = db.prepare("UPDATE allocations SET status='pool' WHERE provider='xisora' AND status='claiming'").run();
    if (r.changes) console.log(`[xisora-bot] recovered ${r.changes} 'claiming' allocations → 'pool'`);
  } catch (_) {}
  status.running = true;
  status.lastError = null; status.lastErrorAt = null;
  _stopped = false;
  console.log(`✓ XISORA bot starting (OTP poll ${OTP_INTERVAL}s, number sync ${NUMBERS_INTERVAL}s, base=${BASE_URL})`);
  setTimeout(async () => {
    try {
      await login();
      console.log('[xisora-bot] initial login complete — running first pool sync');
      await syncPool().catch(e => console.warn('[xisora-bot] initial sync failed:', e.message));
    } catch (e) {
      console.error('[xisora-bot] initial login failed:', e.message);
      status.lastError = e.message;
      status.lastErrorAt = Math.floor(Date.now() / 1000);
      logEvent('error', 'Initial login failed: ' + e.message);
    }
  }, 2000);
  function scheduleOtp() {
    if (_stopped) return;
    otpTimer = setTimeout(async () => {
      if (busy) { scheduleOtp(); return; }
      busy = true;
      try {
        if (!loggedIn) {
          try { await login(); }
          catch (e) {
            status.lastError = 'Re-login: ' + e.message;
            status.lastErrorAt = Math.floor(Date.now() / 1000);
            status.consecFail++;
            busy = false; scheduleOtp(); return;
          }
        }
        const t0 = Date.now();
        const delivered = await Promise.race([
          deliverOtps(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('otp-poll timeout 60s')), 60000)),
        ]);
        status.consecFail = 0;
        lastHeartbeatAt = Math.floor(Date.now() / 1000);
        lastSuccessAt = lastHeartbeatAt;
        if (delivered > 0) console.log(`[xisora-bot] poll delivered ${delivered} OTP(s) in ${Date.now() - t0}ms`);
      } catch (e) {
        status.consecFail++;
        status.lastError = e.message;
        status.lastErrorAt = Math.floor(Date.now() / 1000);
        status.lastScrapeOk = false;
        lastHeartbeatAt = Math.floor(Date.now() / 1000);   // heartbeat fires even on failure
        console.warn(`[xisora-bot] otp-poll fail #${status.consecFail}:`, e.message);
        logEvent('warn', `OTP poll failed (#${status.consecFail}): ${e.message}`);
        if (status.consecFail >= 3) {
          loggedIn = false; status.loggedIn = false; cookieStr = ''; status.consecFail = 0;
        }
      } finally { busy = false; scheduleOtp(); }
    }, OTP_INTERVAL * 1000);
  }
  scheduleOtp();
  // ---- Auto-restart watchdog: checks every OTP_INTERVAL whether the
  //      session is stale for N consecutive intervals and restarts.
  setInterval(async () => {
    if (_stopped || _autoRestartInProgress) return;
    const cfg = resolveAutoRestart();
    if (!cfg.enabled) return;
    if (!status.running) return;
    const now = Math.floor(Date.now() / 1000);
    if (now - _lastAutoRestartTs < AUTO_RESTART_COOLDOWN) return;
    // Stale = no successful poll in (intervals × OTP_INTERVAL) seconds
    const threshold = Math.max(30, cfg.intervals * OTP_INTERVAL);
    if (!lastSuccessAt) return;
    const since = now - lastSuccessAt;
    if (since < threshold) return;
    _autoRestartInProgress = true;
    _lastAutoRestartTs = now;
    const reason = `Stale session: no successful poll in ${since}s (threshold ${threshold}s, ${cfg.intervals} intervals × ${OTP_INTERVAL}s)`;
    try {
      db.prepare(`
        INSERT INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%s','now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run('xisora_autorestart_last_ts', String(now));
      db.prepare(`
        INSERT INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%s','now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run('xisora_autorestart_last_reason', reason);
    } catch (_) {}
    console.warn(`[xisora-bot] AUTO-RESTART triggered — ${reason}`);
    logEvent('warn', `Auto-restart triggered: ${reason}`);
    recordRun({ kind: 'auto-restart', startedAt: now, finishedAt: now, ok: true, error: reason, triggeredBy: 'watchdog' });
    try { await restart(); }
    catch (e) { logEvent('error', 'Auto-restart failed: ' + e.message); }
    finally { _autoRestartInProgress = false; }
  }, Math.max(5, OTP_INTERVAL) * 1000);
  numbersTimer = setInterval(async () => {
    if (busy || !loggedIn) return;
    busy = true;
    try { await syncPool(); }
    catch (e) { console.warn('[xisora-bot] periodic syncPool failed:', e.message); }
    finally { busy = false; }
  }, NUMBERS_INTERVAL * 1000);
  return true;
}
async function stop() {
  _stopped = true;
  if (otpTimer) { clearTimeout(otpTimer); otpTimer = null; }
  if (numbersTimer) { clearInterval(numbersTimer); numbersTimer = null; }
  loggedIn = false; cookieStr = '';
  status.running = false; status.loggedIn = false;
}
async function restart() {
  logEvent('info', 'Restart requested by admin');
  await stop();
  status.lastError = null; status.lastErrorAt = null;
  setTimeout(() => {
    try { start(); logEvent('success', 'Bot restarted'); }
    catch (e) { logEvent('error', 'Restart failed: ' + e.message); }
  }, 1000);
  return true;
}

module.exports = { start, stop, restart, scrapeNow, syncLive, getStatus, logEvent, getRecentOtpFor };
