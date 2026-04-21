// NUMPANEL Bot — hybrid: Puppeteer login + REST API for OTPs.
// Verified live 2026-04-20 against http://51.89.99.105/NumberPanel/agent
//
// Panel structure:
//   /NumberPanel/agent/login           → form: username, password, math captcha
//   /NumberPanel/agent/SelfAllocation  → range list + REQUEST button (allocates a number to agent)
//   /NumberPanel/agent/API             → exposes per-agent API token + CDR endpoint
//
// CDR API (no rate-limit, no captcha, no Puppeteer):
//   GET http://147.135.212.197/crapi/st/viewstats?token={TOKEN}&records=N
//   Returns OTP CDRs in same shape as IMS scrape.
//
// Architecture (mirrors imsBot/msiBot):
//   • Puppeteer used ONLY for: login (math captcha) + scraping range list +
//     clicking REQUEST to add numbers into pool.
//   • OTP polling = pure HTTP fetch on the CDR API → instant, every 3-5s, zero load.
//
// Required env / DB settings (backend/.env on VPS):
//   NUMPANEL_ENABLED=true
//   NUMPANEL_BASE_URL=http://51.89.99.105
//   NUMPANEL_USERNAME=ahmed1258
//   NUMPANEL_PASSWORD=Ahmed@123ff
//   NUMPANEL_API_TOKEN=R1RVQ0FBUzRKjIt9...   (from /NumberPanel/agent/API page)
//   NUMPANEL_API_BASE=http://147.135.212.197/crapi/st/viewstats
//   NUMPANEL_CHROME_PATH=                    (blank = use puppeteer-bundled chromium)
//   NUMPANEL_HEADLESS=true
//   NUMPANEL_SCRAPE_INTERVAL=4               (OTP poll seconds — min 2, can be very fast)
//   NUMPANEL_NUMBERS_INTERVAL=600            (range-list refresh seconds, default 10min)
//   NUMPANEL_REQUEST_PER_RANGE=3             (how many numbers to claim per range each cycle)

const db = require('../lib/db');
const { markOtpReceived } = require('../routes/numbers');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const QUIET = process.env.NODE_ENV === 'production';
const dlog = (...a) => { if (!QUIET) console.log(...a); };
const dwarn = (...a) => { if (!QUIET) console.warn(...a); };

function readSetting(key) {
  try { return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || null; }
  catch (_) { return null; }
}
function writeSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%s','now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, String(value));
}
function truthySetting(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}
// Strip any path/query/hash so BASE_URL stays as scheme+host only.
// Admins sometimes paste the full login URL (http://host/NumberPanel/agent/login) which
// would cause us to build http://host/NumberPanel/agent/login/NumberPanel/agent/login → 403/ERR_ABORTED.
function normalizeBase(raw) {
  const fallback = 'http://51.89.99.105';
  if (!raw) return fallback;
  let s = String(raw).trim().replace(/\/+$/, '');
  if (!s) return fallback;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `http://${s}`);
    return `${u.protocol}//${u.host}`;
  } catch (_) {
    return s.replace(/\/ints\/.*$/i, '').replace(/\/+$/, '') || fallback;
  }
}
function resolveCreds() {
  const dbEnabled = readSetting('numpanel_enabled');
  const dbUser = readSetting('numpanel_username');
  const dbPass = readSetting('numpanel_password');
  const dbBase = readSetting('numpanel_base_url');
  const dbToken = readSetting('numpanel_api_token');
  const dbApiBase = readSetting('numpanel_api_base');
  return {
    ENABLED: dbEnabled !== null ? truthySetting(dbEnabled) : truthySetting(process.env.NUMPANEL_ENABLED || 'false'),
    BASE_URL: normalizeBase(dbBase || process.env.NUMPANEL_BASE_URL),
    USERNAME: dbUser || process.env.NUMPANEL_USERNAME || '',
    PASSWORD: dbPass || process.env.NUMPANEL_PASSWORD || '',
    API_TOKEN: (dbToken || process.env.NUMPANEL_API_TOKEN || '').trim(),
    API_BASE: (dbApiBase || process.env.NUMPANEL_API_BASE || 'http://147.135.212.197/crapi/st/viewstats').trim(),
  };
}
function resolveOtpInterval() {
  const db = +(readSetting('numpanel_otp_interval') || 0);
  const env = +(process.env.NUMPANEL_SCRAPE_INTERVAL || 4);
  return Math.max(2, db > 0 ? db : env);
}
// One-time cleanup: if DB has a polluted numpanel_base_url (e.g. saved with /NumberPanel/agent/login),
// rewrite it to the normalized scheme+host so we don't keep building broken URLs.
try {
  const cur = readSetting('numpanel_base_url');
  if (cur) {
    const fixed = normalizeBase(cur);
    if (fixed && fixed !== cur) {
      db.prepare(`
        INSERT INTO settings (key, value, updated_at) VALUES ('numpanel_base_url', ?, strftime('%s','now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s','now')
      `).run(fixed);
      console.log(`[numpanel-bot] auto-cleaned numpanel_base_url: "${cur}" → "${fixed}"`);
    }
  }
} catch (_) {}

let { ENABLED, BASE_URL, USERNAME, PASSWORD, API_TOKEN, API_BASE } = resolveCreds();
const HEADLESS = String(process.env.NUMPANEL_HEADLESS || 'true').toLowerCase() !== 'false';
const CHROME_PATH = process.env.NUMPANEL_CHROME_PATH || undefined;
let OTP_INTERVAL = resolveOtpInterval();
const NUMBERS_INTERVAL = Math.max(60, +(process.env.NUMPANEL_NUMBERS_INTERVAL || 600));
const EMPTY_LIMIT = Math.max(0, +(process.env.NUMPANEL_EMPTY_LIMIT || 0)); // 0 = disabled by default for NUMPANEL
// How many numbers to claim per range each pool-sync cycle (clicks REQUEST button N times per range)
const REQUEST_PER_RANGE = Math.max(0, +(process.env.NUMPANEL_REQUEST_PER_RANGE || 3));
const LOGIN_FAIL_DISABLE_AFTER = Math.max(1, +(process.env.NUMPANEL_LOGIN_FAIL_DISABLE_AFTER || 1));

let browser = null;
let page = null;
let loggedIn = false;
let busy = false;
let otpTimer = null;
let numbersTimer = null;
let _stopped = false;
let emptyStreak = 0;
let _cookieFailStreak = 0;
let _lastCookieExpiryAlertAt = 0;

async function disableAfterLoginFailure(message) {
  const current = +(readSetting('numpanel_login_fail_count') || 0);
  const next = current + 1;
  writeSetting('numpanel_login_fail_count', next);
  console.warn(`[numpanel-bot] consecutive login failures: ${next}/${LOGIN_FAIL_DISABLE_AFTER}`);
  if (next < LOGIN_FAIL_DISABLE_AFTER) return false;

  writeSetting('numpanel_enabled', '0');
  try { db.prepare(`DELETE FROM settings WHERE key = 'numpanel_login_fail_count'`).run(); } catch (_) {}
  console.error(`[numpanel-bot] ✗ AUTO-DISABLED after login failure — ${message || 're-enable from admin panel after fixing login/cookies'}`);
  logEvent('error', 'Auto-disabled after login failure (circuit breaker tripped)');
  _stopped = true;
  ENABLED = false;
  status.enabled = false;
  status.running = false;
  status.loggedIn = false;
  status.lastError = message || 'NUMPANEL auto-disabled after login failure';
  status.lastErrorAt = Math.floor(Date.now() / 1000);
  if (otpTimer) { clearTimeout(otpTimer); otpTimer = null; }
  if (numbersTimer) { clearInterval(numbersTimer); numbersTimer = null; }
  try { await browser?.close(); } catch (_) {}
  browser = null; page = null; loggedIn = false;
  return true;
}

// Cookie domain — NUMPANEL runs on bare IP so we strip protocol
function cookieDomain() {
  try { return new URL(BASE_URL).hostname; } catch (_) { return '51.89.99.105'; }
}

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
    const poolSize = db.prepare("SELECT COUNT(*) c FROM allocations WHERE provider='numpanel' AND status='pool'").get().c;
    const claimingSize = db.prepare("SELECT COUNT(*) c FROM allocations WHERE provider='numpanel' AND status='claiming'").get().c;
    const activeAssigned = db.prepare("SELECT COUNT(*) c FROM allocations WHERE provider='numpanel' AND status='active'").get().c;
    const otpReceived = db.prepare("SELECT COUNT(*) c FROM allocations WHERE provider='numpanel' AND status='received'").get().c;
    const hasCookies = !!readSetting('numpanel_cookies');
    return {
      ...status, poolSize, claimingSize, activeAssigned, otpReceived,
      events: events.slice(),
      otpCacheSize: recentOtpCache.size,
      emptyStreak, emptyLimit: EMPTY_LIMIT,
      cookieFailStreak: _cookieFailStreak, hasCookies,
    };
  } catch (_) {
    return {
      ...status, poolSize: 0, claimingSize: 0, activeAssigned: 0, otpReceived: 0,
      events: events.slice(), otpCacheSize: 0, emptyStreak, emptyLimit: EMPTY_LIMIT,
      cookieFailStreak: _cookieFailStreak, hasCookies: false,
    };
  }
}

// ---- Math captcha solver (same as IMS) ----
function solveCaptchaText(text) {
  if (!text) return null;
  const norm = String(text)
    .replace(/[×x✕✖⨯·]/gi, '*')
    .replace(/[÷⁄]/g, '/')
    .replace(/[−–—]/g, '-')
    .replace(/[\u00A0\u2000-\u200B]/g, ' ');
  const lhs = norm.split(/=/)[0] || norm;
  const exprMatches = lhs.match(/[-+]?\s*\(?\s*\d+(?:\.\d+)?(?:\s*[+\-*/]\s*\(?\s*\d+(?:\.\d+)?\)?)+/g);
  if (!exprMatches || !exprMatches.length) return null;
  const expr = exprMatches.sort((a, b) => b.length - a.length)[0];
  const safe = expr.replace(/\s+/g, '');
  if (!/^[-+]?[\d+\-*/().]+$/.test(safe)) return null;
  let r;
  try {
    // eslint-disable-next-line no-new-func
    r = Function(`"use strict"; return (${safe});`)();
  } catch (_) { return null; }
  if (typeof r !== 'number' || !isFinite(r)) return null;
  return String(Number.isInteger(r) ? r : Math.round(r * 100) / 100);
}

async function ensureBrowser() {
  if (browser && page) return;
  let puppeteer;
  try {
    puppeteer = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());
  } catch (_) {
    puppeteer = require('puppeteer');
  }
  browser = await puppeteer.launch({
    headless: HEADLESS ? 'new' : false,
    executablePath: CHROME_PATH,
    protocolTimeout: 120000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--lang=en-US,en',
    ],
  });
  page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  loggedIn = false;
}

// ---- Login (handles math captcha) ----
async function loginOnce() {
  dlog('[numpanel-bot] navigating to login page');
  // Block recaptcha + heavy assets so page actually finishes loading in headless
  try {
    if (!page.__numpanelReqIntercept) {
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const u = req.url();
        const t = req.resourceType();
        if (/google\.com\/recaptcha|gstatic\.com\/recaptcha/i.test(u)) return req.abort();
        if (t === 'image' || t === 'font' || t === 'media') return req.abort();
        return req.continue();
      });
      page.__numpanelReqIntercept = true;
    }
  } catch (_) {}

  await page.goto(`${BASE_URL}/NumberPanel/agent/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Flexible password-field probe — scans main frame + every iframe with multiple
  // selector strategies, retries up to ~30s. Handles cases where the form is lazy-
  // loaded, lives inside an iframe, or uses non-standard attributes.
  const PASS_SELECTORS = [
    'input[type="password"]',
    'input[name="password"]',
    'input[name="pwd"]',
    'input[name="pass"]',
    'input[id*="pass" i]',
    'input[placeholder*="pass" i]',
    'input[autocomplete="current-password"]',
  ];
  async function findLoginFrame(maxMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      // Try main frame first, then every child iframe.
      const frames = [page.mainFrame(), ...page.frames().filter(f => f !== page.mainFrame())];
      for (const f of frames) {
        try {
          const hit = await f.evaluate((sels) => {
            for (const s of sels) {
              const el = document.querySelector(s);
              if (el && el.offsetParent !== null) return true;
            }
            return false;
          }, PASS_SELECTORS).catch(() => false);
          if (hit) return f;
        } catch (_) { /* frame may have detached — skip */ }
      }
      await new Promise(r => setTimeout(r, 500));
    }
    return null;
  }
  const loginFrame = await findLoginFrame(30000);
  if (!loginFrame) throw new Error('Login form not found in main frame or any iframe within 30s');

  // Resolve username/password/captcha fields inside the located frame
  const fields = await loginFrame.evaluate((PASS_SELS) => {
    const inputs = Array.from(document.querySelectorAll('input'));
    const visible = inputs.filter(i => i.offsetParent !== null && i.type !== 'hidden');
    let pass = null;
    for (const s of PASS_SELS) {
      const el = document.querySelector(s);
      if (el && visible.includes(el)) { pass = el; break; }
    }
    if (!pass) pass = visible.find(i => i.type === 'password') || null;
    const user = visible.find(i => i !== pass && (i.type === 'text' || !i.type || i.type === 'email'));
    // captcha: input nearest to the math text
    const allText = document.body.innerText || '';
    const mathRe = /(?:what\s*is\s*)?\(?\s*-?\d+\s*(?:[+\-x×*/÷]\s*\(?\s*-?\d+\s*\)?\s*){1,5}=\s*\?/i;
    const mathMatch = allText.match(mathRe);
    const captchaText = mathMatch ? mathMatch[0] : null;
    // Captcha input is the LAST visible non-password, non-user input
    const captcha = visible.filter(i => i !== user && i !== pass && i.type !== 'password').pop() || null;
    const sel = (el) => {
      if (!el) return null;
      if (el.id) return `#${CSS.escape(el.id)}`;
      if (el.name) return `input[name="${el.name}"]`;
      const all = Array.from(document.querySelectorAll('input'));
      return `input:nth-of-type(${all.indexOf(el) + 1})`;
    };
    return { userSel: sel(user), passSel: sel(pass), captchaSel: sel(captcha), captchaText };
  }, PASS_SELECTORS);

  if (!fields.userSel || !fields.passSel) throw new Error('Could not locate login fields');

  // Use the located frame for typing — works for both main frame and iframes.
  await loginFrame.click(fields.userSel, { clickCount: 3 }).catch(() => {});
  await loginFrame.type(fields.userSel, USERNAME, { delay: 25 });
  await loginFrame.click(fields.passSel, { clickCount: 3 }).catch(() => {});
  await loginFrame.type(fields.passSel, PASSWORD, { delay: 25 });

  if (fields.captchaText && fields.captchaSel) {
    const answer = solveCaptchaText(fields.captchaText);
    if (answer) {
      dlog(`[numpanel-bot] captcha "${fields.captchaText.trim()}" → ${answer}`);
      await loginFrame.click(fields.captchaSel, { clickCount: 3 }).catch(() => {});
      await loginFrame.type(fields.captchaSel, answer, { delay: 25 });
    } else {
      dwarn('[numpanel-bot] captcha detected but could not solve:', fields.captchaText);
    }
  }

  await Promise.all([
    loginFrame.evaluate(() => {
      const btn = document.querySelector('button.login100-form-btn, button[type="submit"], input[type="submit"]') ||
                  Array.from(document.querySelectorAll('button')).find(b => /login|sign in/i.test(b.innerText || ''));
      if (btn) btn.click();
    }),
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null),
  ]);

  const url = page.url();
  const ok = !/\/login/i.test(url);
  loggedIn = ok;
  status.loggedIn = ok;
  if (ok) status.lastLoginAt = Math.floor(Date.now() / 1000);
  dlog(`[numpanel-bot] login ${ok ? '✓' : '✗'} (url=${url})`);
  if (!ok) throw new Error('NUMPANEL login failed (likely captcha)');
}

// ---- Session cookie injection (skip captcha if cookies still valid) ----
// Mirrors imsBot — admin pastes cookies (JSON or "k=v; k=v") in admin UI.
function parseCookies(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const txt = raw.trim();
  if (!txt) return [];
  const dom = cookieDomain();
  if (txt.startsWith('[') || txt.startsWith('{')) {
    try {
      const parsed = JSON.parse(txt);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      return arr.filter(c => c && c.name && c.value).map(c => ({
        name: c.name,
        value: String(c.value),
        domain: c.domain || dom,
        path: c.path || '/',
        httpOnly: !!c.httpOnly,
        secure: c.secure === true,
        sameSite: c.sameSite || 'Lax',
      }));
    } catch (_) { /* fall through */ }
  }
  const out = [];
  for (const pair of txt.split(/;\s*/)) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    out.push({ name, value, domain: dom, path: '/', httpOnly: false, secure: false, sameSite: 'Lax' });
  }
  return out;
}

async function tryCookieAuth() {
  const raw = readSetting('numpanel_cookies');
  if (!raw) return false;
  const cookies = parseCookies(raw);
  if (!cookies.length) {
    dwarn('[numpanel-bot] saved cookies present but parse returned 0 entries');
    return false;
  }
  try {
    await page.setCookie(...cookies);
    await page.goto(`${BASE_URL}/NumberPanel/agent/SMSCDRStats`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const url = page.url();
    if (/\/login/i.test(url)) {
      dlog('[numpanel-bot] cookie auth: redirected to /login → expired');
      _cookieFailStreak++;
      maybeAlertCookieExpired('redirected to /login');
      return false;
    }
    const hasContent = await page.evaluate(() => {
      const t = document.querySelectorAll('table').length;
      const txt = (document.body.innerText || '').toLowerCase();
      return t > 0 || /logout|cdr|sms/i.test(txt);
    }).catch(() => false);
    if (!hasContent) {
      dlog('[numpanel-bot] cookie auth: no logged-in content');
      _cookieFailStreak++;
      maybeAlertCookieExpired('no logged-in content on page');
      return false;
    }
    loggedIn = true;
    status.loggedIn = true;
    status.lastLoginAt = Math.floor(Date.now() / 1000);
    _cdrReady = true;
    _cookieFailStreak = 0;
    console.log('[numpanel-bot] ✓ logged in via saved cookies (skipped captcha)');
    logEvent('success', 'Logged in via saved session cookies (no captcha needed)');
    return true;
  } catch (e) {
    dwarn('[numpanel-bot] cookie auth failed:', e.message);
    _cookieFailStreak++;
    maybeAlertCookieExpired(e.message);
    return false;
  }
}

function maybeAlertCookieExpired(reason) {
  if (_cookieFailStreak < 3) return;
  const now = Math.floor(Date.now() / 1000);
  if (now - _lastCookieExpiryAlertAt < 6 * 3600) return;
  _lastCookieExpiryAlertAt = now;
  logEvent('error', `NUMPANEL cookies expired (${_cookieFailStreak} consecutive fails) — refresh needed`);
}

async function login() {
  // 1) Try cookie auth first — instant, no captcha
  if (await tryCookieAuth()) return;

  // 2) Fall back to form login (math captcha)
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Ensure browser+page exist; on retries (or if frame detached), force a clean recycle.
      let needsRecycle = !browser || !page || attempt > 1;
      if (!needsRecycle) {
        try { needsRecycle = page.isClosed(); } catch (_) { needsRecycle = true; }
      }
      if (needsRecycle) {
        try { await browser?.close(); } catch (_) {}
        browser = null; page = null;
        await ensureBrowser();
      }
      await loginOnce();
      if (attempt > 1) logEvent('success', `Login OK on attempt ${attempt}`);
      // Save fresh cookies so next restart skips captcha
      try {
        const fresh = await page.cookies();
        if (fresh && fresh.length) {
          db.prepare(`
            INSERT INTO settings (key, value, updated_at) VALUES ('numpanel_cookies', ?, strftime('%s','now'))
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s','now')
          `).run(JSON.stringify(fresh));
          dlog(`[numpanel-bot] saved ${fresh.length} fresh cookies for next session`);
          logEvent('success', `Saved ${fresh.length} fresh session cookies`);
        }
      } catch (e) { dwarn('[numpanel-bot] failed to save fresh cookies:', e.message); }
      return;
    } catch (e) {
      lastErr = e;
      console.warn(`[numpanel-bot] login attempt ${attempt}/3 failed: ${e.message}`);
      logEvent('warn', `Login attempt ${attempt}/3 failed: ${e.message}`);
      // Tear down so next attempt starts with a fresh browser+page
      try { await browser?.close(); } catch (_) {}
      browser = null; page = null;
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr || new Error('NUMPANEL login failed after 3 attempts');
}

// ---- Self Allocation: scrape range list + click REQUEST per range to claim numbers ----
// Self Allocation table (verified live): Range | Test Number | Currency | 1/1 | 7/1 | 7/7 | 30/45 | Memo | ACTION (REQUEST btn)
// Each click on REQUEST allocates ONE number to the agent and shows it (typically as a toast/popup or in a "Test Number" cell).
// We open the page once, scrape the range list, then click REQUEST up to REQUEST_PER_RANGE times per visible range.
// New numbers are then read from the "Test Number" column on subsequent reloads (or via the SMS Numbers page).
async function scrapeNumbers() {
  await page.goto(`${BASE_URL}/NumberPanel/agent/SelfAllocation`, { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => null);
  if (/\/login/i.test(page.url())) { loggedIn = false; return []; }

  // CRITICAL: Reset "Select Range" and "Select Client" dropdowns to show ALL numbers.
  // NUMPANEL panel pre-selects the first range by default, hiding all other ranges.
  await page.evaluate(() => {
    document.querySelectorAll('select').forEach(sel => {
      const label = (sel.name || sel.id || sel.className || '').toLowerCase() +
                    ((sel.previousElementSibling?.innerText || '') + (sel.closest('label')?.innerText || '')).toLowerCase();
      const isFilter = /range|client|filter/i.test(label) ||
                       Array.from(sel.options).some(o => /select\s*(range|client|all)/i.test(o.text));
      if (!isFilter) return;
      // Pick the blank / "Select Range" / "All" option (usually first with empty value)
      const allOpt = Array.from(sel.options).find(o =>
        o.value === '' || o.value === '0' || /^select|^all|^--/i.test(o.text.trim())
      );
      if (allOpt && sel.value !== allOpt.value) {
        sel.value = allOpt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  }).catch(() => {});
  // Wait for table to reload after filter reset
  await new Promise(r => setTimeout(r, 2000));

  // Also click the Filter button if present (NUMPANEL requires clicking Filter after dropdown change)
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, input[type="submit"], a.btn'))
      .find(b => /^filter$/i.test((b.innerText || b.value || '').trim()));
    if (btn) btn.click();
  }).catch(() => {});
  await new Promise(r => setTimeout(r, 2000));

  // Reset any pre-applied range/client filters by clicking the red "reset" pill or
  // re-loading without query params, then maximize page size via every API we know.
  const sizeInfo = await page.evaluate(() => {
    // 1) Clear any DataTables search/filters
    try {
      // eslint-disable-next-line no-undef
      if (typeof window.jQuery === 'function' && window.jQuery.fn && window.jQuery.fn.dataTable) {
        const $ = window.jQuery;
        const $tables = $('table.dataTable, table');
        $tables.each(function () {
          try {
            const dt = $(this).DataTable();
            dt.search('').columns().search('');
            // Bump page size to ALL (-1) or max numeric option
            const sel = $(this).closest('.dataTables_wrapper').find('select[name$="_length"]')[0];
            let target = -1;
            if (sel) {
              const nums = Array.from(sel.options).map(o => +o.value).filter(n => !isNaN(n));
              if (nums.includes(-1)) target = -1;
              else if (nums.length) target = Math.max(...nums);
            }
            dt.page.len(target).draw();
          } catch (_) {}
        });
      }
    } catch (_) {}

    // 2) Native fallback: change every length <select>
    let bumped = 0;
    document.querySelectorAll('select').forEach(sel => {
      const opts = Array.from(sel.options || []);
      const isLength = /length|show|records|per[\s_]?page/i.test(sel.name || sel.id || sel.className || sel.parentElement?.className || '');
      if (!isLength) return;
      const all = opts.find(o => /all/i.test(o.text) || o.value === '-1');
      let target = null;
      if (all) target = all.value;
      else {
        const nums = opts.filter(o => /^\d+$/.test(o.value)).map(o => +o.value);
        if (nums.length) target = String(Math.max(...nums));
      }
      if (target !== null && sel.value !== target) {
        sel.value = target;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        bumped++;
      }
    });

    // 3) Try clicking any "Reset" / red filter button if present (clears Select Range/Client)
    Array.from(document.querySelectorAll('button, a')).forEach(b => {
      const txt = (b.innerText || b.title || '').trim().toLowerCase();
      if (/reset|clear/i.test(txt) && /filter/i.test((b.title || b.innerText || ''))) {
        try { b.click(); } catch (_) {}
      }
    });

    // Return diagnostics
    const info = document.querySelector('.dataTables_info')?.innerText || '';
    const tableRows = document.querySelectorAll('table tbody tr').length;
    return { bumped, info, tableRows };
  }).catch(() => ({ bumped: 0, info: '', tableRows: 0 }));

  await new Promise(r => setTimeout(r, 1200));
  dlog(`[numpanel-bot] SelfAllocation page loaded (info="${sizeInfo.info}" rows=${sizeInfo.tableRows})`);

  // Walk every visible range row, click its REQUEST button up to REQUEST_PER_RANGE times,
  // and harvest the resulting phone number from the row's Test Number cell or any toast/dialog.
  const collected = [];
  // Get list of range names + selectors for their REQUEST buttons
  const rangeRows = await page.evaluate(() => {
    const rows = [];
    document.querySelectorAll('table tbody tr').forEach((row, idx) => {
      const cells = Array.from(row.querySelectorAll('td')).map(c => c.innerText.trim());
      if (!cells.length) return;
      // Range name = first cell with letters and not a "no data" placeholder
      const range = cells.find(t => /[A-Za-z]/.test(t) && t.length < 80 &&
        !/no.*data|empty|loading|usd|eur|gbp|\$/i.test(t));
      const btn = row.querySelector('a, button, input[type="button"]');
      const hasReq = btn && /request|claim|allocate/i.test((btn.innerText || btn.value || ''));
      if (range && hasReq) rows.push({ range, idx });
    });
    return rows;
  }).catch(() => []);
  dlog(`[numpanel-bot] SelfAllocation: ${rangeRows.length} ranges with REQUEST buttons`);

  if (REQUEST_PER_RANGE === 0) {
    return []; // pool fill disabled
  }

  // Read per-range request_override + disabled from numpanel_range_meta
  let overrideMap = new Map();
  let disabledSet = new Set();
  try {
    const rows = db.prepare(
      `SELECT range_prefix, request_override, disabled FROM numpanel_range_meta`
    ).all();
    for (const row of rows) {
      if (row.request_override != null) overrideMap.set(row.range_prefix, +row.request_override);
      if (row.disabled) disabledSet.add(row.range_prefix);
    }
  } catch (_) { /* table may not exist on first boot */ }

  for (const rr of rangeRows.slice(0, 50)) { // safety cap
    if (disabledSet.has(rr.range)) {
      dlog(`[numpanel-bot] skip DISABLED range: ${rr.range}`);
      continue;
    }
    const perRangeMax = overrideMap.has(rr.range)
      ? Math.max(0, overrideMap.get(rr.range))
      : REQUEST_PER_RANGE;
    if (perRangeMax === 0) continue;
    for (let click = 0; click < perRangeMax; click++) {
      try {
        // Click REQUEST on this row, capture any popup/toast text or the updated row
        const result = await page.evaluate((rowIdx) => {
          const rows = document.querySelectorAll('table tbody tr');
          const row = rows[rowIdx];
          if (!row) return { ok: false, reason: 'row gone' };
          const btn = row.querySelector('a, button, input[type="button"]');
          if (!btn) return { ok: false, reason: 'no btn' };
          btn.click();
          return { ok: true };
        }, rr.idx);
        if (!result?.ok) break;
        // Wait for AJAX
        await new Promise(r => setTimeout(r, 800));
        // Try to read the allocated number from: a toast, the row's Test Number cell, or any dialog
        const phone = await page.evaluate((rowIdx) => {
          // 1) sweetalert/toast/dialog text
          const popups = Array.from(document.querySelectorAll(
            '.swal2-popup, .swal-modal, .toast, .alert, .modal, [role="dialog"], .ui-dialog'
          ));
          for (const p of popups) {
            const m = (p.innerText || '').match(/\b(\d{8,15})\b/);
            if (m) return m[1];
          }
          // 2) updated Test Number cell on the same row
          const rows = document.querySelectorAll('table tbody tr');
          const row = rows[rowIdx];
          if (row) {
            const cells = Array.from(row.querySelectorAll('td')).map(c => c.innerText.trim());
            for (const c of cells) {
              const clean = c.replace(/[\s-+]/g, '');
              if (/^\d{8,15}$/.test(clean)) return clean;
            }
          }
          return null;
        }, rr.idx);
        // Dismiss any open popup
        await page.evaluate(() => {
          document.querySelectorAll('.swal2-confirm, .swal-button--confirm, .modal .close, [role="dialog"] button')
            .forEach(b => { try { b.click(); } catch (_) {} });
        }).catch(() => {});
        await new Promise(r => setTimeout(r, 300));
        if (phone) {
          collected.push({ phone_number: phone, operator: rr.range });
          dlog(`[numpanel-bot] REQUEST → ${rr.range} → ${phone}`);
        } else {
          // No phone found, likely ran out of stock for this range — stop hammering
          break;
        }
      } catch (e) {
        dwarn(`[numpanel-bot] REQUEST click failed on ${rr.range}: ${e.message}`);
        break;
      }
    }
  }
  dlog(`[numpanel-bot] scrapeNumbers DONE: collected ${collected.length} fresh numbers across ${rangeRows.length} ranges`);
  return collected;
}

// ---- Fetch CDR via REST API (no Puppeteer, no rate-limit, no captcha) ----
// API: GET {API_BASE}?token={TOKEN}&records=N
// API_BASE typically = http://147.135.212.197/crapi/st/viewstats (per /agent/API page).
// Response shape (verified 2026-04-20):
//   { status: "ok", records: [ { date, range, number, cli, sms, currency, payout }, ... ] }
//   { status: "error", msg: "No Records Found" }
let _cdrReady = true; // not used for API path, kept for cookie-auth code below

function _httpGetJson(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(e); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: { 'Accept': 'application/json', 'User-Agent': 'NexusX-NumPanelBot/1.0' },
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 2_000_000) { req.destroy(); reject(new Error('response too large')); } });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body, json: body ? JSON.parse(body) : null }); }
        catch (_) { resolve({ status: res.statusCode, body, json: null }); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('http timeout')); });
    req.on('error', reject);
  });
}

async function scrapeOtps() {
  if (!API_TOKEN) {
    dwarn('[numpanel-bot] API_TOKEN not configured — cannot fetch OTPs');
    return [];
  }
  const url = `${API_BASE}?token=${encodeURIComponent(API_TOKEN)}&records=200`;
  const r = await _httpGetJson(url, 12000).catch((e) => {
    dwarn('[numpanel-bot] CDR API fetch error:', e.message);
    return null;
  });
  if (!r) return [];
  if (r.status !== 200) {
    dwarn(`[numpanel-bot] CDR API status ${r.status}: ${r.body.slice(0, 120)}`);
    return [];
  }
  if (!r.json) {
    dwarn('[numpanel-bot] CDR API non-JSON response:', r.body.slice(0, 120));
    return [];
  }
  // Error response: {status:"error", msg:"No Records Found"}
  if (r.json.status === 'error') {
    if (!/no\s*records/i.test(r.json.msg || '')) dwarn('[numpanel-bot] CDR API error:', r.json.msg);
    return [];
  }
  // Records may live under .records, .data, .result, or be the top-level array
  const records = Array.isArray(r.json) ? r.json
    : (r.json.records || r.json.data || r.json.result || []);
  if (!Array.isArray(records)) return [];
  const out = [];
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue;
    const phoneRaw = String(rec.number || rec.Number || rec.phone || rec.NUMBER || '').replace(/[\s-+]/g, '');
    if (!/^\d{8,15}$/.test(phoneRaw)) continue;
    const smsText = String(rec.sms || rec.SMS || rec.message || rec.body || '').trim();
    const cli = (rec.cli || rec.CLI || rec.client || null);
    const dateStr = String(rec.date || rec.DATE || rec.created_at || '').trim();
    let dateTs = null;
    if (dateStr) {
      const t = Date.parse(dateStr.replace(' ', 'T'));
      if (!isNaN(t)) dateTs = Math.floor(t / 1000);
      // Fallback: also try as UTC
      if (!dateTs) {
        const t2 = Date.parse(dateStr.replace(' ', 'T') + 'Z');
        if (!isNaN(t2)) dateTs = Math.floor(t2 / 1000);
      }
    }
    const otpMatch = smsText.match(/\b(\d{3,8})\b/);
    if (!otpMatch) continue;
    out.push({
      phone_number: phoneRaw,
      otp_code: otpMatch[1],
      sms_text: smsText,
      cli: cli || null,
      date_str: dateStr || null,
      date_ts: dateTs,
    });
  }
  return out;
}

// ---- OTP cache (mirror of IMS) ----
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

// ---- Deliver OTPs to active allocations ----
async function deliverOtps() {
  const otps = await scrapeOtps().catch((e) => { dwarn('[numpanel-bot] scrapeOtps:', e.message); return []; });
  status.lastScrapeAt = Math.floor(Date.now() / 1000);
  status.totalScrapes++;
  if (!otps.length) { status.lastScrapeOk = true; return 0; }
  status.lastScrapeOk = true;

  // Cache all
  for (const o of otps) _addToCache(o.phone_number, o);

  // Find active allocations awaiting OTP
  const active = db.prepare(`
    SELECT id, phone_number, allocated_at FROM allocations
    WHERE provider='numpanel' AND status='active' AND otp IS NULL
  `).all();
  if (!active.length) return 0;

  let delivered = 0;
  for (const a of active) {
    const cached = getRecentOtpFor(a.phone_number);
    if (!cached) continue;
    const allocAt = a.allocated_at || 0;
    // Only deliver OTPs received AFTER allocation (avoid stale match)
    if (cached.date_ts && cached.date_ts < allocAt - 120) {
      // Check dup
      const dup = db.prepare(`
        SELECT 1 FROM allocations
        WHERE provider='numpanel' AND phone_number=? AND otp=? AND id<>?
        LIMIT 1
      `).get(a.phone_number, cached.otp_code, a.id);
      if (dup) continue;
    }
    try {
      await markOtpReceived(a, cached.otp_code, cached.cli || null);
      status.otpsDeliveredTotal++;
      delivered++;
      console.log(`[numpanel-bot] OTP delivered: ${a.phone_number} → ${cached.otp_code} (alloc#${a.id})`);
      logEvent('success', `OTP delivered to ${a.phone_number}`, { otp: cached.otp_code, alloc: a.id });
    } catch (e) {
      dwarn(`[numpanel-bot] markOtpReceived failed for ${a.phone_number}:`, e.message);
    }
  }
  return delivered;
}

// ---- Pool sync (numbers) ----
function ensurePoolUser() {
  let u = db.prepare("SELECT id FROM users WHERE username = '__numpanel_pool__'").get();
  if (!u) {
    const r = db.prepare(`INSERT INTO users (username, password_hash, role, status) VALUES ('__numpanel_pool__', '!', 'agent', 'suspended')`).run();
    u = { id: r.lastInsertRowid };
  }
  return u;
}

async function syncPool() {
  const nums = await scrapeNumbers();
  status.lastNumbersScrapeAt = Math.floor(Date.now() / 1000);
  if (!nums.length) {
    emptyStreak++;
    logEvent('warn', `Number scrape returned 0 rows (empty streak ${emptyStreak}${EMPTY_LIMIT > 0 ? '/' + EMPTY_LIMIT : ''})`);
    if (EMPTY_LIMIT > 0 && emptyStreak >= EMPTY_LIMIT) {
      logEvent('warn', `Auto-pausing bot — ${emptyStreak} consecutive empty scrapes`);
      await stop();
    }
    return { added: 0, removed: 0, kept: 0, scraped: 0 };
  }
  emptyStreak = 0;
  const live = new Set(nums.map(n => n.phone_number));
  const sysUser = ensurePoolUser();
  let added = 0, removed = 0, kept = 0;

  const exists = db.prepare("SELECT 1 FROM allocations WHERE provider='numpanel' AND phone_number=? AND status IN ('pool','active','claiming') LIMIT 1");
  const ins = db.prepare(`
    INSERT INTO allocations (user_id, provider, phone_number, country_code, operator, status, allocated_at)
    VALUES (?, 'numpanel', ?, ?, ?, 'pool', strftime('%s','now'))
  `);
  const poolRows = db.prepare("SELECT id, phone_number FROM allocations WHERE provider='numpanel' AND status='pool'").all();
  const del = db.prepare("DELETE FROM allocations WHERE id = ?");

  const tx = db.transaction(() => {
    for (const n of nums) {
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
  if (added || removed) logEvent('success', `Pool sync: +${added} added, -${removed} removed, ${kept} kept (${nums.length} live)`);
  return { added, removed, kept, scraped: nums.length };
}

// ---- Manual one-shot scrapes (admin buttons) ----
async function scrapeNow() {
  if (!status.running) return { ok: false, error: 'Bot is not running' };
  if (busy) return { ok: false, error: 'Already scraping' };
  busy = true;
  try {
    await ensureBrowser();
    if (!loggedIn) await login();
    const before = status.otpsDeliveredTotal;
    const delivered = await deliverOtps();
    return { ok: true, otps: status.otpsDeliveredTotal - before, delivered };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally { busy = false; }
}

async function syncLive() {
  if (!status.running) return { ok: false, error: 'Bot is not running' };
  if (busy) return { ok: false, error: 'Already syncing' };
  busy = true;
  try {
    await ensureBrowser();
    if (!loggedIn) await login();
    logEvent('info', 'Live-sync triggered by admin');
    const r = await syncPool();
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally { busy = false; }
}

// ---- Main loop ----
function start() {
  ({ ENABLED, BASE_URL, USERNAME, PASSWORD } = resolveCreds());
  OTP_INTERVAL = resolveOtpInterval();
  status.enabled = ENABLED;
  status.baseUrl = BASE_URL;
  status.otpIntervalSec = OTP_INTERVAL;
  status.numbersIntervalSec = NUMBERS_INTERVAL;
  const now = Math.floor(Date.now() / 1000);
  if (!ENABLED) {
    status.running = false;
    status.loggedIn = false;
    status.lastError = 'NUMPANEL bot disabled';
    status.lastErrorAt = now;
    logEvent('warn', 'Start skipped — bot disabled');
    console.log('✗ NUMPANEL bot disabled (set NUMPANEL_ENABLED=true or enable from admin panel)');
    return false;
  }
  if (!USERNAME || !PASSWORD) {
    console.warn('✗ NUMPANEL bot: credentials not set');
    status.lastError = 'NUMPANEL credentials not set';
    status.lastErrorAt = now;
    status.running = false;
    status.loggedIn = false;
    logEvent('error', 'Start skipped — NUMPANEL credentials not set');
    return false;
  }
  if (otpTimer) { clearTimeout(otpTimer); otpTimer = null; }
  if (numbersTimer) { clearInterval(numbersTimer); numbersTimer = null; }

  // Recover any orphaned 'claiming' rows back to pool
  try {
    const r = db.prepare("UPDATE allocations SET status='pool' WHERE provider='numpanel' AND status='claiming'").run();
    if (r.changes) console.log(`[numpanel-bot] recovered ${r.changes} 'claiming' allocations → 'pool'`);
  } catch (_) {}

  status.running = true;
  status.lastError = null;
  status.lastErrorAt = null;
  _stopped = false;
  console.log(`✓ NUMPANEL bot starting (OTP poll ${OTP_INTERVAL}s, number sync ${NUMBERS_INTERVAL}s, headless=${HEADLESS}, base=${BASE_URL})`);

  // Initial: login + first pool sync
  setTimeout(async () => {
    if (_stopped || !ENABLED) return;
    try {
      await ensureBrowser();
      if (!loggedIn) await login();
      console.log('[numpanel-bot] initial login complete — running first pool sync');
      await syncPool().catch(e => console.warn('[numpanel-bot] initial sync failed:', e.message));
      // Reset circuit breaker on success
      try {
        db.prepare(`DELETE FROM settings WHERE key = 'numpanel_login_fail_count'`).run();
      } catch (_) {}
    } catch (e) {
      console.error('[numpanel-bot] initial login failed:', e.message);
      logEvent('error', 'Initial login failed: ' + e.message);
      await disableAfterLoginFailure(e.message).catch(be => console.warn('[numpanel-bot] circuit breaker error:', be.message));
    }
  }, 2000);

  // OTP poll loop
  function scheduleOtp() {
    if (_stopped) return;
    otpTimer = setTimeout(async () => {
      if (busy) { scheduleOtp(); return; }
      busy = true;
      try {
        if (!page) { busy = false; scheduleOtp(); return; }
        if (!loggedIn) {
          try { await login(); _cdrReady = false; }
          catch (e) {
            status.consecFail++;
            await disableAfterLoginFailure('Re-login: ' + e.message).catch(be => console.warn('[numpanel-bot] circuit breaker error:', be.message));
            busy = false; return;
          }
        }
        const t0 = Date.now();
        const delivered = await Promise.race([
          deliverOtps(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('otp-poll timeout 60s')), 60000)),
        ]);
        status.consecFail = 0;
        if (delivered > 0) console.log(`[numpanel-bot] poll delivered ${delivered} OTP(s) in ${Date.now() - t0}ms`);
      } catch (e) {
        status.consecFail++;
        status.lastError = e.message;
        status.lastErrorAt = Math.floor(Date.now() / 1000);
        status.lastScrapeOk = false;
        console.warn(`[numpanel-bot] otp-poll fail #${status.consecFail}:`, e.message);
        logEvent('warn', `OTP poll failed (#${status.consecFail}): ${e.message}`);
        // Recycle browser after 3 consecutive fails
        if (status.consecFail >= 3) {
          console.warn('[numpanel-bot] 3 consecutive fails — recycling browser');
          logEvent('warn', 'Recycling browser after 3 fails');
          try { await browser?.close(); } catch (_) {}
          browser = null; page = null; loggedIn = false; _cdrReady = false;
          status.loggedIn = false;
          status.consecFail = 0;
        }
      } finally {
        busy = false;
        scheduleOtp();
      }
    }, OTP_INTERVAL * 1000);
  }
  scheduleOtp();

  // Number pool sync loop (less frequent)
  numbersTimer = setInterval(async () => {
    if (busy || !loggedIn) return;
    busy = true;
    try { await syncPool(); }
    catch (e) { console.warn('[numpanel-bot] periodic syncPool failed:', e.message); }
    finally { busy = false; }
  }, NUMBERS_INTERVAL * 1000);

  return true;
}

async function stop() {
  _stopped = true;
  if (otpTimer) { clearTimeout(otpTimer); otpTimer = null; }
  if (numbersTimer) { clearInterval(numbersTimer); numbersTimer = null; }
  try { await browser?.close(); } catch (_) {}
  browser = null; page = null; loggedIn = false; _cdrReady = false;
  status.running = false;
  status.loggedIn = false;
}

async function restart() {
  logEvent('info', 'Restart requested by admin');
  await stop();
  status.lastError = null;
  status.lastErrorAt = null;
  setTimeout(() => {
    try { start(); logEvent('success', 'Bot restarted'); }
    catch (e) { logEvent('error', 'Restart failed: ' + e.message); }
  }, 1000);
  return true;
}

module.exports = {
  start, stop, restart, scrapeNow, syncLive,
  getStatus, logEvent, getRecentOtpFor,
};
