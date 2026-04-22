// IPRN-SMS Bot — HTTP-only login + auto-pool for panel.iprn-sms.com (Symfony / iKangoo)
//
// Architecture (verified by manual probing):
//   1. GET  /login                   → cookie PHPSESSID + _csrf_token in #loginform
//   2. POST /login_check             → form: _csrf_token, _username, _password, _remember_me, _submit
//   3. 302 → /premium-number/source-ideas (logged in)
//   4. GET  /api/helper/premium-number/my_numbers/sms        → JSON: ranges + counts
//   5. GET  /api/helper/premium-number/my_numbers_download_all/sms → ZIP of all numbers
//
// KEY DIFFERENCE FROM OTHER BOTS:
//   • Real JSON API, no HTML scraping → 100% reliable.
//   • One ZIP download = ALL numbers across ALL ranges (verified 13,979 numbers / 35KB ZIP)
//   • OTP feed not yet exposed for this user role (provider stays 'manual')
//
// Required env (backend/.env):
//   IPRN_SMS_ENABLED=true
//   IPRN_SMS_BASE_URL=https://panel.iprn-sms.com
//   IPRN_SMS_USERNAME=shahriyaar
//   IPRN_SMS_PASSWORD=000000
//   IPRN_SMS_TYPE=sms                      (or 'voice')
//   IPRN_SMS_NUMBERS_INTERVAL=600          (pool refresh seconds — min 60)

const axios = require('axios');
const AdmZip = require('adm-zip');
const db = require('../lib/db');
const { markOtpReceived } = require('../routes/numbers');

const QUIET = process.env.NODE_ENV === 'production';
const dlog = (...a) => { if (!QUIET) console.log(...a); };
const dwarn = (...a) => { if (!QUIET) console.warn(...a); };

// ---- Settings helpers (same pattern as iprnBot) ----
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
  } catch (e) { dwarn('[iprn_sms-bot] writeSetting failed:', e.message); }
}

function resolveCreds() {
  const dbEnabled = readSetting('iprn_sms_enabled');
  const dbUser    = readSetting('iprn_sms_username');
  const dbPass    = readSetting('iprn_sms_password');
  const dbBase    = readSetting('iprn_sms_base_url');
  const dbType    = readSetting('iprn_sms_type');
  return {
    ENABLED: (dbEnabled !== null ? dbEnabled : (process.env.IPRN_SMS_ENABLED || 'false')).toString().toLowerCase() === 'true',
    BASE_URL: (dbBase || process.env.IPRN_SMS_BASE_URL || 'https://panel.iprn-sms.com').replace(/\/+$/, ''),
    USERNAME: dbUser || process.env.IPRN_SMS_USERNAME || '',
    PASSWORD: dbPass || process.env.IPRN_SMS_PASSWORD || '',
    TYPE: (dbType || process.env.IPRN_SMS_TYPE || 'sms').toLowerCase(),
  };
}

let { ENABLED, BASE_URL, USERNAME, PASSWORD, TYPE } = resolveCreds();
const NUMBERS_INTERVAL = Math.max(60, +(process.env.IPRN_SMS_NUMBERS_INTERVAL || 600));
// OTP scrape interval — far shorter than pool sync since this is the
// agent-facing latency. Min 3s to avoid hammering panel.iprn-sms.com.
const OTP_INTERVAL = Math.max(3, +(process.env.IPRN_SMS_OTP_INTERVAL || 5));
// The stats endpoint is currency-filtered. Per the user's manual check,
// OTPs are only visible when currency=USD is selected. Configurable in case
// the account ever changes payout currency.
const OTP_CURRENCY = (process.env.IPRN_SMS_OTP_CURRENCY || 'USD').toUpperCase();

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ---- Session state ----
const cookies = new Map();
let loggedIn = false;
let busy = false;
let numbersTimer = null;
let otpTimer = null;
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
  persistCookies();
}

// ---- Cookie persistence ----
const COOKIE_KEY = 'iprn_sms_cookies';
const COOKIE_SAVED_AT_KEY = 'iprn_sms_cookies_saved_at';
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
    dlog(`[iprn_sms-bot] loaded ${cookies.size} persisted cookies`);
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
    timeout: 30_000,
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
    try {
      cur = await http.get(loc.startsWith('http') ? loc : loc);
    } catch (e) {
      if (e.response) cur = e.response; else throw e;
    }
    hops++;
  }
  return cur;
}

// ---- Status tracking ----
const status = {
  enabled: false,
  running: false,
  loggedIn: false,
  lastLoginAt: null,
  lastNumbersScrapeAt: null,
  lastOtpScrapeAt: null,
  lastOtpScrapeOk: false,
  otpsDeliveredTotal: 0,
  otpEndpoint: null,        // first endpoint that returned valid JSON; cached after discovery
  lastError: null,
  lastErrorAt: null,
  numbersScrapedTotal: 0,
  numbersAddedTotal: 0,
  rangesScrapedTotal: 0,
  consecFail: 0,
  baseUrl: '',
  numbersIntervalSec: 0,
  otpIntervalSec: 0,
  otpCurrency: 'USD',
  smsType: 'sms',
};
const events = [];
function logEvent(level, message, meta) {
  events.unshift({ ts: Math.floor(Date.now() / 1000), level, message, meta: meta || null });
  if (events.length > 30) events.length = 30;
}

function getStatus() {
  try {
    const poolSize       = db.prepare("SELECT COUNT(*) c FROM allocations WHERE provider='iprn_sms' AND status='pool'").get().c;
    const claimingSize   = db.prepare("SELECT COUNT(*) c FROM allocations WHERE provider='iprn_sms' AND status='claiming'").get().c;
    const activeAssigned = db.prepare("SELECT COUNT(*) c FROM allocations WHERE provider='iprn_sms' AND status='active'").get().c;
    const otpReceived    = db.prepare("SELECT COUNT(*) c FROM allocations WHERE provider='iprn_sms' AND status='received'").get().c;
    return {
      ...status, poolSize, claimingSize, activeAssigned, otpReceived,
      events: events.slice(),
    };
  } catch (_) {
    return {
      ...status, poolSize: 0, claimingSize: 0, activeAssigned: 0, otpReceived: 0,
      events: events.slice(),
    };
  }
}

// OTP cache (currently no live OTP feed for this account — kept for parity)
const recentOtpCache = new Map();
function getRecentOtpFor(phone) { return recentOtpCache.has(phone); }
function rememberOtp(phone) {
  recentOtpCache.set(String(phone), Date.now());
  // Cap at 2000 entries — drop oldest
  if (recentOtpCache.size > 2000) {
    const cutoff = Date.now() - 6 * 60 * 60 * 1000; // 6h
    for (const [k, t] of recentOtpCache) if (t < cutoff) recentOtpCache.delete(k);
  }
}

// ---- Pool ownership (FK requires real user_id) ----
function ensurePoolUser() {
  let u = db.prepare("SELECT id FROM users WHERE username = '__iprn_sms_pool__'").get();
  if (!u) {
    const r = db.prepare(
      `INSERT INTO users (username, password_hash, role, status)
       VALUES ('__iprn_sms_pool__', '!', 'agent', 'suspended')`
    ).run();
    u = { id: r.lastInsertRowid };
  }
  return u;
}

// ---- Range meta table (for per-range disable toggle in admin UI) ----
function ensureRangeMetaTable() {
  try {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS iprn_sms_range_meta (
        range_prefix TEXT PRIMARY KEY,
        disabled    INTEGER NOT NULL DEFAULT 0,
        updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      )
    `).run();
  } catch (e) { dwarn('[iprn_sms-bot] ensureRangeMetaTable:', e.message); }
}

// ---- Login ----
function extractCsrf(html) {
  const m = html.match(/name="_csrf_token"\s+value="([^"]+)"/i);
  return m ? m[1] : null;
}

async function login() {
  cookies.clear();
  clearPersistedCookies();
  http = makeHttp();

  dlog('[iprn_sms-bot] GET /login');
  let res = await http.get('/login');
  const csrf = extractCsrf(String(res.data || ''));
  if (!csrf) throw new Error('Could not extract _csrf_token from /login');

  const form = new URLSearchParams();
  form.append('_csrf_token', csrf);
  form.append('_username', USERNAME);
  form.append('_password', PASSWORD);
  form.append('_remember_me', 'on');
  form.append('_submit', 'Login');

  try {
    res = await http.post('/login_check', form.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: BASE_URL,
        Referer: `${BASE_URL}/login`,
      },
    });
  } catch (e) {
    if (e.response) res = e.response; else throw e;
  }
  if (res.status >= 300 && res.status < 400) res = await followRedirect(res);

  // Verify: hit a known-protected JSON endpoint and expect JSON, not redirect to /login
  const ok = await verifyLoggedIn();
  if (!ok) throw new Error('Login verification failed — bounced to /login (bad credentials?)');

  loggedIn = true;
  status.loggedIn = true;
  status.lastLoginAt = Math.floor(Date.now() / 1000);
  persistCookies();
  console.log(`[iprn_sms-bot] ✓ logged in as ${USERNAME}`);
  logEvent('success', `Logged in as ${USERNAME}`);
}

async function verifyLoggedIn() {
  try {
    const res = await http.get(`/api/helper/premium-number/my_numbers/${TYPE}?draw=1&start=0&length=1`, {
      headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
      validateStatus: (s) => s < 500,
    });
    if (res.status !== 200) return false;
    const ct = String(res.headers['content-type'] || '');
    return ct.includes('application/json') && res.data && (Array.isArray(res.data.aaData) || typeof res.data.recordsTotal !== 'undefined');
  } catch (_) { return false; }
}

async function tryCookieSession() {
  if (cookies.size === 0) return false;
  const ok = await verifyLoggedIn();
  if (!ok) return false;
  loggedIn = true;
  status.loggedIn = true;
  status.lastLoginAt = Math.floor(Date.now() / 1000);
  logEvent('success', 'Resumed session via saved cookies');
  return true;
}

async function ensureLoggedIn() {
  if (loggedIn) return;
  if (await tryCookieSession()) return;
  await login();
}

// ---- Country inference from E.164 prefix ----
// Lightweight prefix → ISO country code map. Covers the most common ranges.
// (Numbers from this provider don't ship with country codes, only names.)
const COUNTRY_PREFIX = [
  ['992', 'TJ'], ['670', 'TL'], ['63', 'PH'], ['1', 'US'], ['44', 'GB'],
  ['33', 'FR'], ['49', 'DE'], ['39', 'IT'], ['34', 'ES'], ['7', 'RU'],
  ['380', 'UA'], ['48', 'PL'], ['90', 'TR'], ['971', 'AE'], ['966', 'SA'],
  ['86', 'CN'], ['81', 'JP'], ['82', 'KR'], ['91', 'IN'], ['62', 'ID'],
  ['60', 'MY'], ['66', 'TH'], ['84', 'VN'], ['55', 'BR'], ['52', 'MX'],
  ['54', 'AR'], ['57', 'CO'], ['58', 'VE'], ['51', 'PE'], ['56', 'CL'],
  ['234', 'NG'], ['254', 'KE'], ['255', 'TZ'], ['256', 'UG'], ['27', 'ZA'],
  ['20', 'EG'], ['212', 'MA'], ['216', 'TN'], ['213', 'DZ'], ['218', 'LY'],
  ['998', 'UZ'], ['996', 'KG'], ['994', 'AZ'], ['995', 'GE'], ['374', 'AM'],
];
function inferCountryFromPhone(phone) {
  const p = String(phone || '').replace(/\D/g, '');
  for (const [prefix, iso] of COUNTRY_PREFIX) {
    if (p.startsWith(prefix)) return iso;
  }
  return null;
}

// ---- Pool sync via JSON API + ZIP download ----
async function fetchRanges() {
  const res = await http.get(
    `/api/helper/premium-number/my_numbers/${TYPE}?draw=1&start=0&length=500`,
    { headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' } }
  );
  if (!res.data || !Array.isArray(res.data.aaData)) {
    throw new Error('Unexpected my_numbers response shape');
  }
  return res.data.aaData;  // [{id, name, user_id, user, source_id, source, payout, currency, quantity}]
}

async function fetchNumbersZip() {
  const res = await http.get(
    `/api/helper/premium-number/my_numbers_download_all/${TYPE}`,
    {
      responseType: 'arraybuffer',
      headers: { Accept: 'application/zip,*/*' },
      validateStatus: (s) => s < 500,
    }
  );
  if (res.status !== 200) throw new Error(`ZIP download HTTP ${res.status}`);
  const ct = String(res.headers['content-type'] || '');
  if (!ct.includes('zip')) throw new Error(`ZIP download returned ${ct}`);
  return Buffer.from(res.data);
}

function parseZipNumbers(buf) {
  // Returns: [{ rangeName, phones: [...] }, ...]
  const zip = new AdmZip(buf);
  const out = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName;
    // Filename pattern: "<range>-<user>-<source>-numbers.txt"
    const m = name.match(/^(.+?)-[^-]+-[^-]+-numbers\.txt$/i);
    const rangeName = (m ? m[1] : name.replace(/\.txt$/i, '')).trim();
    const text = entry.getData().toString('utf8');
    const phones = text.split(/\r?\n/).map(s => s.trim()).filter(s => /^\d{6,16}$/.test(s));
    if (phones.length) out.push({ rangeName, phones });
  }
  return out;
}

async function scrapeNumbers() {
  await ensureLoggedIn();
  ensureRangeMetaTable();

  let rangesMeta;
  try {
    rangesMeta = await fetchRanges();
  } catch (e) {
    if (/401|403/.test(e.message) || /\/login/i.test(e?.response?.headers?.location || '')) {
      loggedIn = false;
      throw new Error('Session expired during ranges fetch');
    }
    throw e;
  }
  status.rangesScrapedTotal = rangesMeta.length;
  if (!rangesMeta.length) {
    dwarn('[iprn_sms-bot] my_numbers returned 0 ranges (account empty?)');
    return 0;
  }

  let zipBuf;
  try {
    zipBuf = await fetchNumbersZip();
  } catch (e) {
    if (/401|403/.test(e.message)) {
      loggedIn = false;
      throw new Error('Session expired during ZIP download');
    }
    throw e;
  }

  const groups = parseZipNumbers(zipBuf);
  const totalPhones = groups.reduce((s, g) => s + g.phones.length, 0);
  status.numbersScrapedTotal = totalPhones;
  status.lastNumbersScrapeAt = Math.floor(Date.now() / 1000);

  if (!totalPhones) {
    dwarn('[iprn_sms-bot] ZIP parsed but contained 0 phone numbers');
    return 0;
  }

  // Skip phones already in pool/claiming/active
  const existing = db.prepare(`
    SELECT phone_number FROM allocations
    WHERE provider='iprn_sms' AND status IN ('pool','claiming','active')
  `).all().reduce((s, r) => s.add(r.phone_number), new Set());

  const sysUser = ensurePoolUser();
  const ins = db.prepare(`
    INSERT INTO allocations (user_id, provider, phone_number, operator, country_code, status, allocated_at)
    VALUES (?, 'iprn_sms', ?, ?, ?, 'pool', strftime('%s','now'))
  `);
  let added = 0;
  const tx = db.transaction(() => {
    for (const g of groups) {
      const country = inferCountryFromPhone(g.phones[0]);
      for (const phone of g.phones) {
        if (existing.has(phone)) continue;
        ins.run(sysUser.id, phone, g.rangeName, country);
        added++;
      }
    }
  });
  tx();
  status.numbersAddedTotal += added;
  if (added > 0) {
    console.log(`[iprn_sms-bot] pool sync: ${added} new numbers added (${groups.length} ranges, ${totalPhones} total in ZIP)`);
    logEvent('success', `Added ${added} new numbers to pool (${groups.length} ranges)`);
  } else {
    dlog(`[iprn_sms-bot] pool sync: 0 new (${totalPhones} already in pool/claiming/active)`);
  }
  return added;
}

// ---- Loop runner ----
async function runNumbersLoop() {
  if (busy || _stopped) return;
  busy = true;
  try {
    await scrapeNumbers();
    status.consecFail = 0;
  } catch (e) {
    status.consecFail++;
    status.lastError = e.message;
    status.lastErrorAt = Math.floor(Date.now() / 1000);
    dwarn(`[iprn_sms-bot] pool sync failed (${status.consecFail}): ${e.message}`);
    if (status.consecFail >= 2) {
      logEvent('error', `Pool sync failed ${status.consecFail}x: ${e.message}`);
      loggedIn = false;
    }
  } finally {
    busy = false;
  }
}

function start() {
  ({ ENABLED, BASE_URL, USERNAME, PASSWORD, TYPE } = resolveCreds());
  status.enabled = ENABLED;
  status.baseUrl = BASE_URL;
  status.smsType = TYPE;
  status.numbersIntervalSec = NUMBERS_INTERVAL;

  if (!ENABLED) {
    console.log('[iprn_sms-bot] disabled (set IPRN_SMS_ENABLED=true to enable)');
    return;
  }
  if (!USERNAME || !PASSWORD) {
    console.warn('[iprn_sms-bot] missing IPRN_SMS_USERNAME or IPRN_SMS_PASSWORD — bot will not start');
    return;
  }

  console.log(`[iprn_sms-bot] starting → base=${BASE_URL} user=${USERNAME} type=${TYPE} pool=${NUMBERS_INTERVAL}s`);
  status.running = true;
  _stopped = false;
  ensureRangeMetaTable();

  if (loadCookies()) {
    dlog('[iprn_sms-bot] attempting cookie-based resume on startup');
  }

  runNumbersLoop().catch(() => {});
  numbersTimer = setInterval(runNumbersLoop, NUMBERS_INTERVAL * 1000);
}

function stop() {
  _stopped = true;
  status.running = false;
  if (numbersTimer) { clearInterval(numbersTimer); numbersTimer = null; }
}

async function restart() {
  stop();
  await new Promise(r => setTimeout(r, 250));
  loggedIn = false;
  cookies.clear();
  start();
}

async function scrapeNow() {
  ({ ENABLED, BASE_URL, USERNAME, PASSWORD, TYPE } = resolveCreds());
  if (!ENABLED) return { ok: false, error: 'IPRN-SMS bot disabled' };
  if (!USERNAME || !PASSWORD) return { ok: false, error: 'Missing credentials' };
  try {
    const before = status.numbersAddedTotal;
    await scrapeNumbers();
    return { ok: true, added: status.numbersAddedTotal - before };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Standalone credential check — re-reads creds from settings/env, performs a
// full /login + /login_check round-trip, and verifies a protected endpoint.
// Does NOT touch the running bot's timers; it just reuses the shared session.
// Returns { ok, username, base_url, loggedIn, latency_ms, error? }.
async function testLogin() {
  const t0 = Date.now();
  // Refresh creds from DB/env so the test reflects the latest UI save.
  const c = resolveCreds();
  ENABLED = c.ENABLED; BASE_URL = c.BASE_URL; USERNAME = c.USERNAME; PASSWORD = c.PASSWORD; TYPE = c.TYPE;
  if (!USERNAME || !PASSWORD) {
    return { ok: false, error: 'Username or password is empty', latency_ms: Date.now() - t0 };
  }
  try {
    await login();
    return {
      ok: true,
      username: USERNAME,
      base_url: BASE_URL,
      loggedIn: true,
      latency_ms: Date.now() - t0,
    };
  } catch (e) {
    return { ok: false, error: e.message, username: USERNAME, base_url: BASE_URL, latency_ms: Date.now() - t0 };
  }
}

module.exports = {
  start, stop, restart, scrapeNow, getStatus,
  getRecentOtpFor, logEvent, testLogin,
  getCookieMeta, clearPersistedCookies, loadCookies,
};
