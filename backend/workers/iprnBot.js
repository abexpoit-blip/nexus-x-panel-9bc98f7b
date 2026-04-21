// IPRN Bot — HTTP-only login + scraper for iprndata.com (Yii2 panel)
//
// Architecture (verified by scripts/iprndata-login-poc.js):
//   1. GET  /user-management/auth/login   → cookies + CSRF token
//   2. POST /user-management/auth/login   → set session cookie
//   3. GET  /dashboard                    → confirms login (redirect-aware)
//   4. GET  /billing-groups/index         → number pool table
//   5. GET  /sms-records/index            → OTP feed (recent SMS)
//
// KEY DIFFERENCE FROM IMS/MSI BOTS:
//   • NO puppeteer / chromium needed → ~5x lighter (10MB RAM vs 500MB)
//   • NO captcha (Yii2 auth is just CSRF + creds)
//   • Re-login automatic on session expiry (any redirect to /login)
//
// Required env (backend/.env):
//   IPRN_ENABLED=true
//   IPRN_BASE_URL=https://iprndata.com
//   IPRN_USERNAME=MAMUN25
//   IPRN_PASSWORD=mamun@11aa
//   IPRN_SCRAPE_INTERVAL=4   (OTP poll seconds — min 2)
//   IPRN_NUMBERS_INTERVAL=600 (pool refresh seconds — min 60)

const axios = require('axios');
const db = require('../lib/db');
const { markOtpReceived } = require('../routes/numbers');

const QUIET = process.env.NODE_ENV === 'production';
const dlog = (...a) => { if (!QUIET) console.log(...a); };
const dwarn = (...a) => { if (!QUIET) console.warn(...a); };

function readSetting(key) {
  try { return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || null; }
  catch (_) { return null; }
}

function writeSetting(key, value) {
  try {
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%s','now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s','now')
    `).run(key, value);
  } catch (e) { dwarn('[iprn-bot] writeSetting failed:', e.message); }
}

function resolveCreds() {
  const dbEnabled = readSetting('iprn_enabled');
  const dbUser    = readSetting('iprn_username');
  const dbPass    = readSetting('iprn_password');
  const dbBase    = readSetting('iprn_base_url');
  return {
    ENABLED: (dbEnabled !== null ? dbEnabled : (process.env.IPRN_ENABLED || 'false')).toString().toLowerCase() === 'true',
    BASE_URL: (dbBase || process.env.IPRN_BASE_URL || 'https://iprndata.com').replace(/\/+$/, ''),
    USERNAME: dbUser || process.env.IPRN_USERNAME || '',
    PASSWORD: dbPass || process.env.IPRN_PASSWORD || '',
  };
}

function resolveOtpInterval() {
  const dbV = +(readSetting('iprn_otp_interval') || 0);
  const env = +(process.env.IPRN_SCRAPE_INTERVAL || 4);
  return Math.max(2, dbV > 0 ? dbV : env);
}

let { ENABLED, BASE_URL, USERNAME, PASSWORD } = resolveCreds();
let OTP_INTERVAL = resolveOtpInterval();
const NUMBERS_INTERVAL = Math.max(60, +(process.env.IPRN_NUMBERS_INTERVAL || 600));

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ---- Session state ----
const cookies = new Map(); // name → value
let loggedIn = false;
let busy = false;
let otpTimer = null;
let numbersTimer = null;
let _stopped = false;

function cookieHeader() {
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
function absorbSetCookie(headers) {
  const sc = headers && headers['set-cookie'];
  if (!sc) return;
  for (const line of sc) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  // Persist whenever the upstream rotates them so we survive restarts.
  persistCookies();
}

// ---- Cookie persistence (settings table — no extra schema needed) -------
const COOKIE_KEY = 'iprn_cookies';
const COOKIE_SAVED_AT_KEY = 'iprn_cookies_saved_at';
function persistCookies() {
  try {
    if (cookies.size === 0) return;
    writeSetting(COOKIE_KEY, JSON.stringify([...cookies.entries()]));
    writeSetting(COOKIE_SAVED_AT_KEY, String(Math.floor(Date.now() / 1000)));
  } catch (_) {}
}
function loadCookies() {
  try {
    const raw = readSetting(COOKIE_KEY);
    if (!raw) return false;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0) return false;
    cookies.clear();
    for (const [k, v] of arr) cookies.set(k, v);
    dlog(`[iprn-bot] loaded ${cookies.size} persisted cookies`);
    return true;
  } catch (_) { return false; }
}
function clearPersistedCookies() {
  cookies.clear();
  try { db.prepare('DELETE FROM settings WHERE key IN (?, ?)').run(COOKIE_KEY, COOKIE_SAVED_AT_KEY); } catch (_) {}
}
function getCookieMeta() {
  return {
    has_cookies: cookies.size > 0,
    count: cookies.size,
    saved_at: +(readSetting(COOKIE_SAVED_AT_KEY) || 0) || null,
    names: [...cookies.keys()],
  };
}

function makeHttp() {
  const http = axios.create({
    baseURL: BASE_URL,
    maxRedirects: 0,
    validateStatus: (s) => s >= 200 && s < 400,
    timeout: 20_000,
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  http.interceptors.request.use((cfg) => {
    const c = cookieHeader();
    if (c) cfg.headers.Cookie = c;
    return cfg;
  });
  http.interceptors.response.use(
    (res) => { absorbSetCookie(res.headers); return res; },
    (err) => { if (err.response) absorbSetCookie(err.response.headers); return Promise.reject(err); }
  );
  return http;
}
let http = makeHttp();

async function followRedirect(res) {
  let cur = res, hops = 0;
  while ([301, 302, 303, 307, 308].includes(cur.status) && hops < 5) {
    const loc = cur.headers.location;
    if (!loc) break;
    cur = await http.get(loc.startsWith('http') ? loc : loc);
    hops++;
  }
  return cur;
}

function extractCsrf(html) {
  const m =
    html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/i) ||
    html.match(/name="_csrf-frontend"\s+value="([^"]+)"/i) ||
    html.match(/name="_csrf"\s+value="([^"]+)"/i);
  return m ? m[1] : null;
}
function extractCsrfFieldName(html) {
  const m = html.match(/name="(_csrf[^"]*)"/i);
  return m ? m[1] : '_csrf-frontend';
}

// ---- Status tracking ----
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
    const poolSize       = db.prepare("SELECT COUNT(*) c FROM allocations WHERE provider='iprn' AND status='pool'").get().c;
    const claimingSize   = db.prepare("SELECT COUNT(*) c FROM allocations WHERE provider='iprn' AND status='claiming'").get().c;
    const activeAssigned = db.prepare("SELECT COUNT(*) c FROM allocations WHERE provider='iprn' AND status='active'").get().c;
    const otpReceived    = db.prepare("SELECT COUNT(*) c FROM allocations WHERE provider='iprn' AND status='received'").get().c;
    return {
      ...status, poolSize, claimingSize, activeAssigned, otpReceived,
      events: events.slice(),
      otpCacheSize: recentOtpCache.size,
    };
  } catch (_) {
    return {
      ...status, poolSize: 0, claimingSize: 0, activeAssigned: 0, otpReceived: 0,
      events: events.slice(), otpCacheSize: 0,
    };
  }
}

// ---- Recent-OTP cache (so provider.getNumber skips stale numbers) ----
const recentOtpCache = new Map(); // phone → ts
function rememberOtp(phone) {
  recentOtpCache.set(phone, Date.now());
  // GC older than 30min
  const cutoff = Date.now() - 30 * 60_000;
  for (const [k, v] of recentOtpCache) if (v < cutoff) recentOtpCache.delete(k);
}
function getRecentOtpFor(phone) { return recentOtpCache.has(phone); }

// ---- Login ----
async function login() {
  cookies.clear();
  clearPersistedCookies();
  http = makeHttp();

  dlog('[iprn-bot] GET /user-management/auth/login');
  let res = await http.get('/user-management/auth/login');
  const csrfToken = extractCsrf(res.data);
  const csrfField = extractCsrfFieldName(res.data);
  if (!csrfToken) throw new Error('Could not extract CSRF token from login page');

  const form = new URLSearchParams();
  form.append(csrfField, csrfToken);
  form.append('LoginForm[username]', USERNAME);
  form.append('LoginForm[password]', PASSWORD);
  form.append('LoginForm[rememberMe]', '0');
  form.append('login-button', '');

  try {
    res = await http.post('/user-management/auth/login', form.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRF-Token': csrfToken,
        Origin: BASE_URL,
        Referer: `${BASE_URL}/user-management/auth/login`,
      },
    });
  } catch (e) {
    if (e.response) res = e.response; else throw e;
  }
  if (res.status >= 300 && res.status < 400) res = await followRedirect(res);

  // Verify session
  res = await http.get('/dashboard');
  if ([301, 302, 303, 307, 308].includes(res.status)) res = await followRedirect(res);

  // Verification: a successful login means we are NOT bounced back to /login.
  // We used to require a hard-coded marker like "Dashboard" or "logout" but
  // that broke whenever IPRN reskinned the panel. The robust signal is:
  //   • final URL is not /login, AND
  //   • the response body does NOT contain the LoginForm field again.
  const finalUrl = res.request?.path || res.config?.url || '';
  const html = String(res.data || '');
  const bouncedToLogin = /\/login/i.test(finalUrl);
  const stillOnLoginForm = /name="LoginForm\[username\]/i.test(html);
  if (bouncedToLogin || stillOnLoginForm) {
    throw new Error('Login verification failed — got bounced to /login (bad credentials?)');
  }

  loggedIn = true;
  status.loggedIn = true;
  status.lastLoginAt = Math.floor(Date.now() / 1000);
  persistCookies();
  console.log(`[iprn-bot] ✓ logged in as ${USERNAME}`);
  logEvent('success', `Logged in as ${USERNAME}`);
}

// Try the persisted cookie session first; fall back to a fresh login on
// any sign of session expiry. This is the "auto-login when cookies fail"
// flow the user asked for — works transparently across restarts.
async function tryCookieSession() {
  if (cookies.size === 0) return false;
  try {
    let res = await http.get('/dashboard');
    if ([301, 302, 303, 307, 308].includes(res.status)) res = await followRedirect(res);
    const html = String(res.data || '');
    const finalUrl = res.request?.path || res.config?.url || '';
    const looksLikeLogin = /\/login/i.test(finalUrl) || /name="LoginForm/i.test(html);
    if (looksLikeLogin) return false;
    loggedIn = true;
    status.loggedIn = true;
    status.lastLoginAt = Math.floor(Date.now() / 1000);
    logEvent('success', 'Resumed session via saved cookies');
    return true;
  } catch (_) { return false; }
}

async function ensureLoggedIn() {
  if (loggedIn) return;
  // 1) Try saved cookies (fast path — no captcha, no CSRF roundtrip)
  if (await tryCookieSession()) return;
  // 2) Fall back to a clean login
  await login();
}

// ---- Pool scrape: /numbers/index ----
// The IPRN panel (per actual UI: iprndata.com/numbers/index) shows the
// real number inventory — what /billing-groups/index used to return was
// a SUMMARY, not the actual rows. We now hit the real /numbers/index
// table directly so the admin Pool view matches the upstream panel.
// Yii2 GridView markup: <table>...<tbody><tr><td>...</td></tr></tbody></table>
// Columns vary per account; we extract phone numbers (E.164 / digits ≥7) from each row.
function parsePoolRows(html) {
  const tbody = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tbody) return [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  const rows = [];
  let m;
  while ((m = rowRe.exec(tbody[1])) !== null) {
    const cells = [];
    let cm;
    while ((cm = cellRe.exec(m[1])) !== null) {
      cells.push(cm[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
    }
    if (!cells.length) continue;
    // Find first cell that looks like a phone (digits, optional +, 7-15 chars)
    const phoneCell = cells.find(c => /^\+?\d[\d\s\-]{6,}$/.test(c));
    if (!phoneCell) continue;
    const phone = phoneCell.replace(/[\s\-]/g, '');
    const range = cells[0] || 'Unknown';        // first column usually = group/range
    const country = cells.find(c => /^[A-Z]{2}$/.test(c)) || null;
    rows.push({ phone, range, country });
  }
  return rows;
}

async function scrapeNumbers() {
  await ensureLoggedIn();
  // Pull a healthy first page of the inventory. Yii2 GridView paginates
  // server-side so per-page=100 is the upper-safe value most installs allow.
  let res = await http.get('/numbers/index?per-page=100');
  if ([301, 302, 303].includes(res.status)) res = await followRedirect(res);
  if (/\/login/i.test(res.request?.path || res.config?.url || '')) {
    loggedIn = false;
    throw new Error('Session expired during pool scrape');
  }

  const rows = parsePoolRows(String(res.data || ''));
  status.numbersScrapedTotal += rows.length;
  status.lastNumbersScrapeAt = Math.floor(Date.now() / 1000);

  if (!rows.length) {
    dwarn('[iprn-bot] pool scrape returned 0 rows (table empty or markup changed)');
    return 0;
  }

  // Upsert into allocations as pool entries (skip if already present in pool/claiming/active)
  const existing = db.prepare(`
    SELECT phone_number FROM allocations
    WHERE provider='iprn' AND status IN ('pool','claiming','active')
  `).all().reduce((s, r) => s.add(r.phone_number), new Set());

  const ins = db.prepare(`
    INSERT INTO allocations (provider, phone_number, operator, country_code, status, allocated_at, user_id)
    VALUES ('iprn', ?, ?, ?, 'pool', strftime('%s','now'), 0)
  `);
  let added = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (existing.has(r.phone)) continue;
      ins.run(r.phone, r.range, r.country);
      added++;
    }
  });
  tx();
  status.numbersAddedTotal += added;
  if (added > 0) {
    console.log(`[iprn-bot] pool sync: ${added} new numbers added (total scraped this round: ${rows.length})`);
    logEvent('success', `Added ${added} new IPRN numbers to pool`);
  } else {
    dlog(`[iprn-bot] pool sync: 0 new (${rows.length} already in pool/claiming/active)`);
  }
  return added;
}

// ---- OTP scrape: /sms-records/index ----
function parseSmsRows(html) {
  const tbody = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tbody) return [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  const rows = [];
  let m;
  while ((m = rowRe.exec(tbody[1])) !== null) {
    const cells = [];
    let cm;
    while ((cm = cellRe.exec(m[1])) !== null) {
      cells.push(cm[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
    }
    if (cells.length < 2) continue;
    // Find phone cell + the "long text" cell (SMS body) — body is the longest
    const phoneCell = cells.find(c => /^\+?\d[\d\s\-]{6,}$/.test(c));
    const bodyCell  = cells.slice().sort((a, b) => b.length - a.length)[0];
    if (!phoneCell || !bodyCell || bodyCell.length < 8) continue;
    rows.push({
      phone: phoneCell.replace(/[\s\-]/g, ''),
      body: bodyCell,
      cli: cells.find(c => /^[A-Z][A-Z0-9_]{1,20}$/.test(c)) || null,
    });
  }
  return rows;
}

function extractOtp(text) {
  if (!text) return null;
  // Common OTP formats: "Your code is 123456", "OTP: 1234", "...code 12345...", standalone 4-8 digit
  const m =
    text.match(/\b(?:code|otp|pin|password|verification)[\s:]*[A-Z]?(\d{4,8})\b/i) ||
    text.match(/\b(\d{4,8})\b(?:\s*(?:is|=))?/);
  return m ? m[1] : null;
}

async function scrapeOtps() {
  await ensureLoggedIn();
  let res = await http.get('/sms-records/index');
  if ([301, 302, 303].includes(res.status)) res = await followRedirect(res);
  if (/\/login/i.test(res.request?.path || res.config?.url || '')) {
    loggedIn = false;
    throw new Error('Session expired during OTP scrape');
  }

  const rows = parseSmsRows(String(res.data || ''));
  status.lastScrapeAt = Math.floor(Date.now() / 1000);
  status.lastScrapeOk = true;
  status.totalScrapes++;

  let delivered = 0;
  for (const r of rows) {
    const otp = extractOtp(r.body);
    if (!otp) continue;
    rememberOtp(r.phone);

    // Match active IPRN allocation with no OTP yet
    const a = db.prepare(`
      SELECT * FROM allocations
      WHERE provider='iprn' AND phone_number=? AND status='active' AND otp IS NULL
      ORDER BY allocated_at DESC LIMIT 1
    `).get(r.phone);
    if (!a) continue;

    try {
      await markOtpReceived(a, otp, r.cli);
      delivered++;
      status.otpsDeliveredTotal++;
      console.log(`[iprn-bot] ✓ OTP delivered: ${r.phone} → ${otp} (user_id=${a.user_id})`);
      logEvent('success', `OTP delivered: ${r.phone} → ${otp}`);
    } catch (e) {
      dwarn('[iprn-bot] markOtpReceived failed:', e.message);
    }
  }
  return delivered;
}

// ---- Loop runner ----
async function runOtpLoop() {
  if (busy || _stopped) return;
  busy = true;
  try {
    await scrapeOtps();
    status.consecFail = 0;
  } catch (e) {
    status.consecFail++;
    status.lastError = e.message;
    status.lastErrorAt = Math.floor(Date.now() / 1000);
    status.lastScrapeOk = false;
    dwarn(`[iprn-bot] OTP scrape failed (${status.consecFail}): ${e.message}`);
    if (status.consecFail >= 3) {
      logEvent('error', `OTP scrape failed ${status.consecFail}x: ${e.message}`);
      loggedIn = false; // force re-login on next cycle
    }
  } finally {
    busy = false;
  }
}

async function runNumbersLoop() {
  try {
    await scrapeNumbers();
  } catch (e) {
    status.lastError = e.message;
    status.lastErrorAt = Math.floor(Date.now() / 1000);
    dwarn(`[iprn-bot] pool sync failed: ${e.message}`);
    logEvent('warn', `Pool sync failed: ${e.message}`);
    loggedIn = false;
  }
}

function start() {
  ({ ENABLED, BASE_URL, USERNAME, PASSWORD } = resolveCreds());
  OTP_INTERVAL = resolveOtpInterval();
  status.enabled = ENABLED;
  status.baseUrl = BASE_URL;
  status.otpIntervalSec = OTP_INTERVAL;
  status.numbersIntervalSec = NUMBERS_INTERVAL;

  if (!ENABLED) {
    console.log('[iprn-bot] disabled (set IPRN_ENABLED=true to enable)');
    return;
  }
  if (!USERNAME || !PASSWORD) {
    console.warn('[iprn-bot] missing IPRN_USERNAME or IPRN_PASSWORD — bot will not start');
    return;
  }

  console.log(`[iprn-bot] starting → base=${BASE_URL} user=${USERNAME} otp=${OTP_INTERVAL}s pool=${NUMBERS_INTERVAL}s`);
  status.running = true;
  _stopped = false;

  // Kick off first pool sync immediately, then on interval
  runNumbersLoop().catch(() => {});
  numbersTimer = setInterval(runNumbersLoop, NUMBERS_INTERVAL * 1000);

  // Start OTP polling loop
  otpTimer = setInterval(runOtpLoop, OTP_INTERVAL * 1000);
}

function stop() {
  _stopped = true;
  status.running = false;
  if (otpTimer) { clearInterval(otpTimer); otpTimer = null; }
  if (numbersTimer) { clearInterval(numbersTimer); numbersTimer = null; }
}

async function restart() {
  stop();
  // Allow in-flight loops to settle before restarting
  await new Promise(r => setTimeout(r, 250));
  loggedIn = false;
  cookies.clear();
  start();
}

async function scrapeNow() {
  ({ ENABLED, BASE_URL, USERNAME, PASSWORD } = resolveCreds());
  if (!ENABLED) return { ok: false, error: 'IPRN bot disabled' };
  if (!USERNAME || !PASSWORD) return { ok: false, error: 'Missing credentials' };
  try {
    const beforeAdded = status.numbersAddedTotal;
    const beforeOtps = status.otpsDeliveredTotal;
    await scrapeNumbers();
    const otps = await scrapeOtps();
    return {
      ok: true,
      added: status.numbersAddedTotal - beforeAdded,
      otps: (status.otpsDeliveredTotal - beforeOtps) || otps || 0,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { start, stop, restart, scrapeNow, getStatus, getRecentOtpFor, logEvent };
module.exports.getCookieMeta = getCookieMeta;
module.exports.clearPersistedCookies = clearPersistedCookies;
module.exports.loadCookies = loadCookies;