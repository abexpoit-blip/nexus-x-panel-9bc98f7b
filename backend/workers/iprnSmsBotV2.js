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
//   IPRN_SMS_V2_ENABLED=true
//   IPRN_SMS_V2_BASE_URL=https://panel.iprn-sms.com
//   IPRN_SMS_V2_USERNAME=shahriyaar
//   IPRN_SMS_V2_PASSWORD=000000
//   IPRN_SMS_V2_TYPE=sms                      (or 'voice')
//   IPRN_SMS_V2_NUMBERS_INTERVAL=600          (pool refresh seconds — min 60)

const axios = require('axios');
const AdmZip = require('adm-zip');
const db = require('../lib/db');
const { markOtpReceived } = require('../routes/numbers');
const { logOtpEvent, trimIfDue } = require('../lib/otpAudit');

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
  } catch (e) { dwarn('[iprn_sms_v2-bot] writeSetting failed:', e.message); }
}

function resolveCreds() {
  const dbEnabled = readSetting('iprn_sms_v2_enabled');
  const dbUser    = readSetting('iprn_sms_v2_username');
  const dbPass    = readSetting('iprn_sms_v2_password');
  const dbBase    = readSetting('iprn_sms_v2_base_url');
  const dbType    = readSetting('iprn_sms_v2_type');
  return {
    ENABLED: (dbEnabled !== null ? dbEnabled : (process.env.IPRN_SMS_V2_ENABLED || 'false')).toString().toLowerCase() === 'true',
    BASE_URL: (dbBase || process.env.IPRN_SMS_V2_BASE_URL || 'https://panel.iprn-sms.com').replace(/\/+$/, ''),
    USERNAME: dbUser || process.env.IPRN_SMS_V2_USERNAME || '',
    PASSWORD: dbPass || process.env.IPRN_SMS_V2_PASSWORD || '',
    TYPE: (dbType || process.env.IPRN_SMS_V2_TYPE || 'sms').toLowerCase(),
  };
}

let { ENABLED, BASE_URL, USERNAME, PASSWORD, TYPE } = resolveCreds();
const NUMBERS_INTERVAL = Math.max(60, +(process.env.IPRN_SMS_V2_NUMBERS_INTERVAL || 600));
// OTP scrape interval — far shorter than pool sync since this is the
// agent-facing latency. Min 3s to avoid hammering panel.iprn-sms.com.
const OTP_INTERVAL = Math.max(3, +(process.env.IPRN_SMS_V2_OTP_INTERVAL || 5));
// The stats endpoint is currency-filtered. Verified by live DevTools capture:
// the panel uses NUMERIC currency_id (NOT a currency string):
//   currency_id=1 → EUR (default, returns no rows for our account)
//   currency_id=2 → USD (the one with all the OTPs — matches user's screenshots)
// We send 2 by default; admins can override with IPRN_SMS_V2_CURRENCY_ID=N.
const OTP_CURRENCY_ID = String(+(process.env.IPRN_SMS_V2_CURRENCY_ID || 2));
const OTP_CURRENCY = 'USD'; // human-readable label used in audit log only

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
const COOKIE_KEY = 'iprn_sms_v2_cookies';
const COOKIE_SAVED_AT_KEY = 'iprn_sms_v2_cookies_saved_at';
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
    dlog(`[iprn_sms_v2-bot] loaded ${cookies.size} persisted cookies`);
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
    const poolSize       = db.prepare("SELECT COUNT(*) c FROM allocations WHERE provider='iprn_sms_v2' AND status='pool'").get().c;
    const claimingSize   = db.prepare("SELECT COUNT(*) c FROM allocations WHERE provider='iprn_sms_v2' AND status='claiming'").get().c;
    const activeAssigned = db.prepare("SELECT COUNT(*) c FROM allocations WHERE provider='iprn_sms_v2' AND status='active'").get().c;
    const otpReceived    = db.prepare("SELECT COUNT(*) c FROM allocations WHERE provider='iprn_sms_v2' AND status='received'").get().c;
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
function phoneVariants(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return [];
  const vars = new Set([digits]);
  // Portal stats rows currently expose the sold number with an international
  // "00" prefix (e.g. 00639...), while the pool/import may store the same
  // number as bare E.164 digits (e.g. 639...). Match against BOTH so OTPs
  // still credit regardless of which side added/removed the 00 prefix.
  if (digits.startsWith('00') && digits.length > 4) {
    vars.add(digits.replace(/^00+/, ''));
  } else if (digits.length > 6) {
    vars.add(`00${digits}`);
  }
  return [...vars];
}
function getRecentOtpFor(phone) {
  return phoneVariants(phone).some((p) => recentOtpCache.has(p));
}
function rememberOtp(phone) {
  for (const p of phoneVariants(phone)) recentOtpCache.set(p, Date.now());
  // Cap at 2000 entries — drop oldest
  if (recentOtpCache.size > 2000) {
    const cutoff = Date.now() - 6 * 60 * 60 * 1000; // 6h
    for (const [k, t] of recentOtpCache) if (t < cutoff) recentOtpCache.delete(k);
  }
}

// ---- Pool ownership (FK requires real user_id) ----
function ensurePoolUser() {
  let u = db.prepare("SELECT id FROM users WHERE username = '__iprn_sms_v2_pool__'").get();
  if (!u) {
    const r = db.prepare(
      `INSERT INTO users (username, password_hash, role, status)
       VALUES ('__iprn_sms_v2_pool__', '!', 'agent', 'suspended')`
    ).run();
    u = { id: r.lastInsertRowid };
  }
  return u;
}

// ---- Range meta table (for per-range disable toggle in admin UI) ----
function ensureRangeMetaTable() {
  try {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS iprn_sms_v2_range_meta (
        range_prefix TEXT PRIMARY KEY,
        disabled    INTEGER NOT NULL DEFAULT 0,
        updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      )
    `).run();
    // Extra columns to match other providers' range_meta so the shared
    // RangePoolGrid admin UI can edit custom_name/tag_color/priority/notes/etc.
    const cols = db.prepare(`PRAGMA table_info(iprn_sms_v2_range_meta)`).all().map(c => c.name);
    const addCol = (name, ddl) => {
      if (!cols.includes(name)) {
        try { db.prepare(`ALTER TABLE iprn_sms_v2_range_meta ADD COLUMN ${name} ${ddl}`).run(); } catch (_) {}
      }
    };
    addCol('custom_name',      'TEXT');
    addCol('tag_color',        'TEXT');
    addCol('priority',         'INTEGER');
    addCol('request_override', 'INTEGER');
    addCol('notes',            'TEXT');
    addCol('service_tag',      'TEXT');
  } catch (e) { dwarn('[iprn_sms_v2-bot] ensureRangeMetaTable:', e.message); }
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

  dlog('[iprn_sms_v2-bot] GET /login');
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
  console.log(`[iprn_sms_v2-bot] ✓ logged in as ${USERNAME}`);
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
    dwarn('[iprn_sms_v2-bot] my_numbers returned 0 ranges (account empty?)');
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
    dwarn('[iprn_sms_v2-bot] ZIP parsed but contained 0 phone numbers');
    return 0;
  }

  // Skip phones already in pool/claiming/active
  const existing = db.prepare(`
    SELECT phone_number FROM allocations
    WHERE provider='iprn_sms_v2' AND status IN ('pool','claiming','active')
  `).all().reduce((s, r) => s.add(r.phone_number), new Set());

  const sysUser = ensurePoolUser();
  const ins = db.prepare(`
    INSERT INTO allocations (user_id, provider, phone_number, operator, country_code, status, allocated_at)
    VALUES (?, 'iprn_sms_v2', ?, ?, ?, 'pool', strftime('%s','now'))
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
    console.log(`[iprn_sms_v2-bot] pool sync: ${added} new numbers added (${groups.length} ranges, ${totalPhones} total in ZIP)`);
    logEvent('success', `Added ${added} new numbers to pool (${groups.length} ranges)`);
  } else {
    dlog(`[iprn_sms_v2-bot] pool sync: 0 new (${totalPhones} already in pool/claiming/active)`);
  }
  return added;
}

// ============================================================
// OTP scraper — pulls the Statistics DataTable feed
// ============================================================
// The user verified manually: OTPs are visible on
//   https://panel.iprn-sms.com/premium_number/stats/sms
// only when the Currency filter is set to USD. We hit the same
// DataTables AJAX with currency=USD and parse the Message column.
//
// The exact AJAX URL is not documented; we try a small list of
// likely Symfony route patterns and cache the first one that
// returns JSON with rows. This avoids needing a separate probe step.

function todayStr() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
}

// Verified by live DevTools capture on panel.iprn-sms.com (2026-04-22):
//   GET /api/helper/premium-number/stats/sms.json
//       ?date_from=DD/MM/YYYY HH&date_to=DD/MM/YYYY HH
//       &currency_id=2&draw=1&start=0&length=25
//   → {recordsFiltered, recordsTotal, currencySymbol:"$", aaData:[{
//        source:"FACEBOOK", name:"...", short_code:"00639...",
//        phone_number:"Facebook" (CLI/source label, mislabeled by panel!),
//        payout, message:"...code 123456...", notified, created
//     }, ...]}
// IMPORTANT: panel field naming is confusing —
//   short_code   = the actual phone number we sold to the agent
//   phone_number = the CLI/sender name (e.g., "Facebook")
// Currency_id mapping observed on panel.iprn-sms.com:
//   1 = EUR, 2 = USD, 3 = GBP
const CURRENCY_ID_BY_CODE = { EUR: 1, USD: 2, GBP: 3 };
const OTP_CURRENCIES = ['USD', 'EUR']; // user wants BOTH scraped each cycle

function buildOtpEndpointCandidates(currency) {
  const t = todayStr();
  const cur = String(currency || 'USD').toUpperCase();
  const cid = CURRENCY_ID_BY_CODE[cur] || 2;
  const qsCode =
    `date_from=${encodeURIComponent(t + ' 00')}` +
    `&date_to=${encodeURIComponent(t + ' 23')}` +
    `&currency=${cur}` +
    `&draw=1&start=0&length=200&search%5Bvalue%5D=&search%5Bregex%5D=false`;
  const qsId =
    `date_from=${encodeURIComponent(t + ' 00')}` +
    `&date_to=${encodeURIComponent(t + ' 23')}` +
    `&currency_id=${cid}` +
    `&draw=1&start=0&length=200&search%5Bvalue%5D=&search%5Bregex%5D=false`;
  return [
    `/api/helper/premium-number/stats/${TYPE}.json?${qsId}`,
    `/api/helper/premium-number/stats/${TYPE}?${qsCode}`,
    `/api/helper/premium-number/stats/${TYPE}.json?${qsCode}`,
    `/api/helper/premium-number/stats/${TYPE}?${qsId}`,
    `/api/helper/premium-number/stats-data/${TYPE}.json?${qsCode}`,
    `/api/helper/premium-number/sms-stats/${TYPE}.json?${qsCode}`,
  ];
}

function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n || 0))
    .replace(/&#x([\da-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16) || 0));
}

function htmlToVisibleText(input) {
  const raw = String(input || '');
  if (!raw) return '';
  return decodeHtmlEntities(raw)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(div|p|span|a|td|tr|li|ul|ol)>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractOtpFromMessage(text) {
  if (!text) return null;
  const s = String(text);
  const m =
    s.match(/\b(?:code|otp|pin|password|verification|c[oó]digo)[\s:#-]*[A-Z]?(\d{3,8})\b/i) ||
    s.match(/(?:^|[^\d])(\d{4,8})\s+is\s+your/i) ||
    s.match(/<#>\s*(\d{4,8})\b/) ||
    s.match(/\b(\d{4,8})\b/);
  return m ? m[1] : null;
}

// Normalize a row from the unknown DataTables shape into {phone, message, cli}
function normalizeStatsRow(row) {
  if (!row) return null;
  // Object shape
  if (typeof row === 'object' && !Array.isArray(row)) {
    // ⚠ panel.iprn-sms.com uses CONFUSING field names:
    //   short_code   → the real phone number (e.g., "00639279110294")
    //   phone_number → the CLI / sender label (e.g., "Facebook")
    // Try short_code FIRST, then fall back to other naming conventions
    // used by other iKangoo installs.
    const phone =
      row.short_code || row.number || row.phone || row.msisdn || row.dnis || null;
    const rawMessage =
      row.full_message || row.original_message || row.message || row.text || row.body || row.sms || null;
    const message = rawMessage ? htmlToVisibleText(rawMessage) : null;
    const cli =
      row.cli || row.source || row.sender || row.phone_number /* CLI label here */ || null;
    if (phone && message) {
      return {
        phone: String(phone).replace(/\D/g, ''),
        message: String(message),
        cli: cli ? String(cli) : null,
      };
    }
    return null;
  }
  // Array shape: try to identify phone + longest text
  if (Array.isArray(row)) {
    const cells = row.map((c) => (c == null ? '' : String(c).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()));
    const phone = cells.find((c) => /^\+?\d[\d\s\-]{6,}$/.test(c));
    const sorted = cells.slice().sort((a, b) => b.length - a.length);
    const message = sorted[0];
    if (phone && message && message.length >= 6) {
      const cli = cells.find((c) => /^[A-Za-z][A-Za-z0-9_]{1,20}$/.test(c)) || null;
      return { phone: phone.replace(/\D/g, ''), message, cli };
    }
  }
  return null;
}

async function fetchStatsOnce(url) {
  const res = await http.get(url, {
    headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
    validateStatus: (s) => s < 600,
  });
  const ct = String(res.headers['content-type'] || '');
  if (res.status >= 300 && res.status < 400) {
    // Redirected to /login => session dead
    const loc = res.headers.location || '';
    if (/\/login/i.test(loc)) {
      loggedIn = false;
      throw new Error('Session expired during OTP scrape');
    }
  }
  if (res.status !== 200 || !ct.includes('application/json')) {
    return { ok: false, status: res.status, ct };
  }
  const body = res.data;
  const rows = Array.isArray(body?.aaData) ? body.aaData
              : Array.isArray(body?.data) ? body.data
              : Array.isArray(body) ? body
              : null;
  if (!rows) return { ok: false, status: res.status, ct, reason: 'no rows array' };
  const totalRows = Math.max(
    +(body?.recordsFiltered || 0),
    +(body?.recordsTotal || 0),
    rows.length,
  );
  return { ok: true, rows, totalRows };
}

function withStatsPaging(url, start, length) {
  const u = new URL(url, BASE_URL);
  u.searchParams.set('start', String(Math.max(0, +start || 0)));
  u.searchParams.set('length', String(Math.max(1, +length || 200)));
  return `${u.pathname}?${u.searchParams.toString()}`;
}

async function fetchAllStatsRows(url, firstPage) {
  const pageSize = 200;
  const first = firstPage || await fetchStatsOnce(withStatsPaging(url, 0, pageSize));
  if (!first?.ok) return first;
  const rows = Array.isArray(first.rows) ? first.rows.slice() : [];
  const totalRows = Math.max(+first.totalRows || 0, rows.length);
  for (let start = rows.length; start < totalRows; start += pageSize) {
    const next = await fetchStatsOnce(withStatsPaging(url, start, pageSize));
    if (!next?.ok || !Array.isArray(next.rows) || next.rows.length === 0) break;
    rows.push(...next.rows);
    if (next.rows.length < pageSize) break;
  }
  return { ok: true, rows, totalRows: rows.length };
}

function findActiveAllocationByScrapedPhone(scrapedPhone) {
  let best = null;
  const sel = db.prepare(`
    SELECT * FROM allocations
    WHERE provider='iprn_sms_v2' AND phone_number=? AND status='active' AND otp IS NULL
    ORDER BY allocated_at DESC LIMIT 1
  `);
  for (const candidate of phoneVariants(scrapedPhone)) {
    const row = sel.get(candidate);
    if (!row) continue;
    if (!best || (row.allocated_at || 0) > (best.allocated_at || 0)) best = row;
  }
  return best;
}

async function scrapeOtps() {
  await ensureLoggedIn();
  if (!status.otpEndpoints) status.otpEndpoints = {};
  let total = 0;
  const outcomes = {};
  for (const cur of OTP_CURRENCIES) {
    try {
      total += await scrapeOtpsForCurrency(cur, outcomes);
      outcomes[cur] = outcomes[cur] || { ok: true };
    } catch (e) {
      if (/Session expired/.test(e.message)) throw e;
      outcomes[cur] = { ok: false, error: e.message, tried: buildOtpEndpointCandidates(cur) };
      dwarn(`[iprn_sms_v2-bot] ${cur} scrape failed:`, e.message);
    }
  }
  const failed = OTP_CURRENCIES.filter((c) => outcomes[c] && !outcomes[c].ok);
  const succeeded = OTP_CURRENCIES.filter((c) => outcomes[c] && outcomes[c].ok);
  if (failed.length && succeeded.length) {
    const prevKey = (status._lastDivergence || '');
    const key = `${failed.join(',')}|${succeeded.join(',')}`;
    for (const cur of failed) {
      const o = outcomes[cur];
      const triedList = (o.tried || []).map((u, i) => `  ${i + 1}. ${u}`).join('\n');
      const detail = `${cur} scrape FAILED while ${succeeded.join('+')} succeeded.\nError: ${o.error}\nTried ${o.tried?.length || 0} endpoints:\n${triedList}`;
      logEvent('error', `[ALERT] iprn_sms_v2 ${cur} OTP scrape failing (${succeeded.join('+')} ok) — ${o.error}`);
      logOtpEvent({
        provider: 'iprn_sms_v2',
        event: 'currency_divergence',
        currency: cur,
        endpoint: (o.tried && o.tried[0]) || null,
        detail,
      });
    }
    status._lastDivergence = key;
    if (prevKey !== key) {
      console.warn(`[iprn_sms_v2-bot] ⚠ ALERT: ${failed.join(',')} failing while ${succeeded.join(',')} works`);
    }
  } else if (status._lastDivergence && failed.length === 0) {
    logEvent('success', `[RECOVERY] iprn_sms_v2 all currencies (${succeeded.join('+')}) scraping ok`);
    status._lastDivergence = '';
  }
  return total;
}

async function scrapeOtpsForCurrency(currency) {
  const cached = status.otpEndpoints && status.otpEndpoints[currency];
  const tryList = cached
    ? [cached, ...buildOtpEndpointCandidates(currency).filter((u) => u !== cached)]
    : buildOtpEndpointCandidates(currency);

  let result = null;
  let workingUrl = null;
  for (const url of tryList) {
    try {
      const firstPage = await fetchStatsOnce(url);
      if (firstPage.ok) {
        result = await fetchAllStatsRows(url, firstPage);
        workingUrl = url;
        break;
      }
    } catch (e) {
      if (/Session expired/.test(e.message)) throw e;
      // try next
    }
  }

  status.lastOtpScrapeAt = Math.floor(Date.now() / 1000);
  if (!result) {
    status.lastOtpScrapeOk = false;
    throw new Error(`No working OTP stats endpoint for ${currency} (tried ${tryList.length}). Run scripts/iprn-sms-stats-probe.js`);
  }
  status.lastOtpScrapeOk = true;
  if (status.otpEndpoints[currency] !== workingUrl) {
    status.otpEndpoints[currency] = workingUrl;
    status.otpEndpoint = workingUrl;
    console.log(`[iprn_sms_v2-bot] OTP endpoint resolved (${currency}): ${workingUrl}`);
    logEvent('success', `OTP endpoint resolved (${currency}): ${workingUrl}`);
  }

  let delivered = 0;
  for (const raw of result.rows) {
    const row = normalizeStatsRow(raw);
    if (!row) continue;
    const otp = extractOtpFromMessage(row.message);
    if (!otp) continue;

    rememberOtp(row.phone);

    const a = findActiveAllocationByScrapedPhone(row.phone);
    if (!a) {
      // Log unmatched OTPs too so admin can see "we saw an OTP but no agent
      // had this number active" — useful when agents complain "OTP missing"
      // because their allocation already expired.
      logOtpEvent({
        provider: 'iprn_sms_v2',
        event: 'no_match',
        phone_number: row.phone,
        otp_code: otp,
        endpoint: workingUrl,
        currency,
        detail: `Saw OTP for ${row.phone} but no active allocation (${phoneVariants(row.phone).join(' / ')})`,
      });
      continue;
    }

    try {
      await markOtpReceived(a, otp, row.cli, { endpoint: workingUrl, currency });
      logOtpEvent({
        provider: 'iprn_sms_v2',
        event: 'matched',
        user_id: a.user_id,
        allocation_id: a.id,
        phone_number: row.phone,
        otp_code: otp,
        endpoint: workingUrl,
        currency,
        detail: [
          row.cli ? `Matched (${row.cli})` : 'Matched',
          a.phone_number && a.phone_number !== row.phone ? `stored=${a.phone_number}` : null,
        ].filter(Boolean).join(' · '),
      });
      delivered++;
      status.otpsDeliveredTotal++;
      console.log(`[iprn_sms_v2-bot] ✓ OTP delivered: ${row.phone} → ${otp} (user_id=${a.user_id})`);
      logEvent('success', `OTP delivered: ${row.phone} → ${otp}`);
    } catch (e) {
      dwarn('[iprn_sms_v2-bot] markOtpReceived failed:', e.message);
      logOtpEvent({
        provider: 'iprn_sms_v2', event: 'scrape_fail',
        phone_number: row.phone, otp_code: otp,
        endpoint: workingUrl, currency,
        detail: `markOtpReceived error: ${e.message}`,
      });
    }
  }
  // One scrape_ok row per cycle so agents can SEE the bot is alive even
  // when no OTPs land. Keeps audit page from looking dead between matches.
  logOtpEvent({
    provider: 'iprn_sms_v2', event: 'scrape_ok',
    rows_seen: result.rows.length, matches_found: delivered,
    endpoint: workingUrl, currency,
    detail: `Polled ${result.rows.length} rows · ${delivered} matched`,
  });
  trimIfDue();
  return delivered;
}

async function runOtpLoop() {
  if (_stopped) return;
  try {
    await scrapeOtps();
    status.consecFail = 0;
  } catch (e) {
    status.consecFail++;
    status.lastError = e.message;
    status.lastErrorAt = Math.floor(Date.now() / 1000);
    if (status.consecFail % 6 === 1) {
      dwarn(`[iprn_sms_v2-bot] OTP scrape failed (${status.consecFail}): ${e.message}`);
      logEvent('error', `OTP scrape failed ${status.consecFail}x: ${e.message}`);
    }
    logOtpEvent({
      provider: 'iprn_sms_v2', event: 'scrape_fail',
      endpoint: status.otpEndpoint, currency: OTP_CURRENCY,
      detail: e.message,
    });
    if (/Session expired/.test(e.message)) loggedIn = false;
  }
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
    dwarn(`[iprn_sms_v2-bot] pool sync failed (${status.consecFail}): ${e.message}`);
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
  status.otpIntervalSec = OTP_INTERVAL;
  status.otpCurrency = OTP_CURRENCY;

  if (!ENABLED) {
    console.log('[iprn_sms_v2-bot] disabled (set IPRN_SMS_V2_ENABLED=true to enable)');
    return;
  }
  if (!USERNAME || !PASSWORD) {
    console.warn('[iprn_sms_v2-bot] missing IPRN_SMS_V2_USERNAME or IPRN_SMS_V2_PASSWORD — bot will not start');
    return;
  }

  console.log(`[iprn_sms_v2-bot] starting → base=${BASE_URL} user=${USERNAME} type=${TYPE} pool=${NUMBERS_INTERVAL}s`);
  status.running = true;
  _stopped = false;
  ensureRangeMetaTable();

  if (loadCookies()) {
    dlog('[iprn_sms_v2-bot] attempting cookie-based resume on startup');
  }

  runNumbersLoop().catch(() => {});
  numbersTimer = setInterval(runNumbersLoop, NUMBERS_INTERVAL * 1000);

  // Kick off OTP scrape loop (currency-filtered stats endpoint)
  console.log(`[iprn_sms_v2-bot] OTP poller starting → currency=${OTP_CURRENCY} interval=${OTP_INTERVAL}s`);
  runOtpLoop().catch(() => {});
  otpTimer = setInterval(runOtpLoop, OTP_INTERVAL * 1000);
}

function stop() {
  _stopped = true;
  status.running = false;
  if (numbersTimer) { clearInterval(numbersTimer); numbersTimer = null; }
  if (otpTimer) { clearInterval(otpTimer); otpTimer = null; }
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
