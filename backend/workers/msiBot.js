// MSI Browser Bot — headless Chrome that stays logged into 145.239.130.45/ints
// and scrapes the agent's numbers + OTP CDRs.
//
// MSI panel structure (verified live 2026-04-20):
//   /ints/login                  → form: username, password, math captcha (e.g. "What is 6+5=?")
//   /ints/agent/MySMSNumbers     → number pool (Range | Prefix | Number | My Payout | Client | Limits)
//   /ints/agent/SMSCDRReports    → CDR (Date | Range | Number | CLI | Client | SMS | Currency | Payout)
//                                  Default range = TODAY 00:00 → 23:59. Auto-loads on page open.
//
// KEY DIFFERENCE FROM IMS BOT:
//   • NO 15s rate-limit between actions → can scrape every 4–5s safely
//   • NO cookie-bypass needed (captcha is cheap math, just re-solve on each login)
//   • Same data shape as IMS, so we mirror the allocation flow exactly
//
// Required env (backend/.env on VPS):
//   MSI_ENABLED=true
//   MSI_BASE_URL=http://145.239.130.45
//   MSI_USERNAME=Ashik07
//   MSI_PASSWORD=Shovon@2013
//   MSI_CHROME_PATH=/usr/bin/chromium-browser   (or empty for puppeteer's bundled chrome)
//   MSI_HEADLESS=true
//   MSI_SCRAPE_INTERVAL=5      (OTP poll interval seconds — min 3)
//   MSI_NUMBERS_INTERVAL=600   (number-pool refresh seconds — min 60, default 10min)

const db = require('../lib/db');
const { markOtpReceived } = require('../routes/numbers');

const QUIET = process.env.NODE_ENV === 'production';
const dlog = (...a) => { if (!QUIET) console.log(...a); };
const dwarn = (...a) => { if (!QUIET) console.warn(...a); };

function readSetting(key) {
  try { return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || null; }
  catch (_) { return null; }
}
function resolveCreds() {
  const dbEnabled = readSetting('msi_enabled');
  const dbUser = readSetting('msi_username');
  const dbPass = readSetting('msi_password');
  const dbBase = readSetting('msi_base_url');
  return {
    ENABLED: (dbEnabled !== null ? dbEnabled : (process.env.MSI_ENABLED || 'false')).toString().toLowerCase() === 'true',
    BASE_URL: (dbBase || process.env.MSI_BASE_URL || 'http://145.239.130.45').replace(/\/$/, ''),
    USERNAME: dbUser || process.env.MSI_USERNAME || '',
    PASSWORD: dbPass || process.env.MSI_PASSWORD || '',
  };
}
function resolveOtpInterval() {
  const db = +(readSetting('msi_otp_interval') || 0);
  const env = +(process.env.MSI_SCRAPE_INTERVAL || 5);
  return Math.max(3, db > 0 ? db : env);
}
let { ENABLED, BASE_URL, USERNAME, PASSWORD } = resolveCreds();
const HEADLESS = String(process.env.MSI_HEADLESS || 'true').toLowerCase() !== 'false';
const CHROME_PATH = process.env.MSI_CHROME_PATH || undefined;
let OTP_INTERVAL = resolveOtpInterval();
const NUMBERS_INTERVAL = Math.max(60, +(process.env.MSI_NUMBERS_INTERVAL || 600));
const EMPTY_LIMIT = Math.max(0, +(process.env.MSI_EMPTY_LIMIT || 0)); // 0 = disabled by default for MSI

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

// Cookie domain — MSI runs on bare IP so we strip protocol
function cookieDomain() {
  try { return new URL(BASE_URL).hostname; } catch (_) { return '145.239.130.45'; }
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
    const poolSize = db.prepare("SELECT COUNT(*) c FROM allocations WHERE provider='msi' AND status='pool'").get().c;
    const claimingSize = db.prepare("SELECT COUNT(*) c FROM allocations WHERE provider='msi' AND status='claiming'").get().c;
    const activeAssigned = db.prepare("SELECT COUNT(*) c FROM allocations WHERE provider='msi' AND status='active'").get().c;
    const otpReceived = db.prepare("SELECT COUNT(*) c FROM allocations WHERE provider='msi' AND status='received'").get().c;
    const hasCookies = !!readSetting('msi_cookies');
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
  dlog('[msi-bot] navigating to login page');
  // Block recaptcha + heavy assets so page actually finishes loading in headless
  try {
    if (!page.__msiReqIntercept) {
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const u = req.url();
        const t = req.resourceType();
        if (/google\.com\/recaptcha|gstatic\.com\/recaptcha/i.test(u)) return req.abort();
        if (t === 'image' || t === 'font' || t === 'media') return req.abort();
        return req.continue();
      });
      page.__msiReqIntercept = true;
    }
  } catch (_) {}

  await page.goto(`${BASE_URL}/ints/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait for password field — try multiple selectors
  await page.waitForSelector('input[type="password"], input[name="password"]', { timeout: 30000 });

  // Resolve username/password fields (MSI uses unnamed inputs inside a form)
  const fields = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input'));
    const visible = inputs.filter(i => i.offsetParent !== null && i.type !== 'hidden');
    const pass = visible.find(i => i.type === 'password');
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
  });

  if (!fields.userSel || !fields.passSel) throw new Error('Could not locate login fields');

  await page.click(fields.userSel, { clickCount: 3 }).catch(() => {});
  await page.type(fields.userSel, USERNAME, { delay: 25 });
  await page.click(fields.passSel, { clickCount: 3 }).catch(() => {});
  await page.type(fields.passSel, PASSWORD, { delay: 25 });

  if (fields.captchaText && fields.captchaSel) {
    const answer = solveCaptchaText(fields.captchaText);
    if (answer) {
      dlog(`[msi-bot] captcha "${fields.captchaText.trim()}" → ${answer}`);
      await page.click(fields.captchaSel, { clickCount: 3 }).catch(() => {});
      await page.type(fields.captchaSel, answer, { delay: 25 });
    } else {
      dwarn('[msi-bot] captcha detected but could not solve:', fields.captchaText);
    }
  }

  await Promise.all([
    page.evaluate(() => {
      const btn = document.querySelector('button[type="submit"], input[type="submit"]') ||
                  Array.from(document.querySelectorAll('button')).find(b => /login|sign in/i.test(b.innerText || ''));
      if (btn) btn.click();
    }),
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null),
  ]);

  const url = page.url();
  const ok = !/\/login/i.test(url);
  loggedIn = ok;
  status.loggedIn = ok;
  if (ok) status.lastLoginAt = Math.floor(Date.now() / 1000);
  dlog(`[msi-bot] login ${ok ? '✓' : '✗'} (url=${url})`);
  if (!ok) throw new Error('MSI login failed (likely captcha)');
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
  const raw = readSetting('msi_cookies');
  if (!raw) return false;
  const cookies = parseCookies(raw);
  if (!cookies.length) {
    dwarn('[msi-bot] saved cookies present but parse returned 0 entries');
    return false;
  }
  try {
    await page.setCookie(...cookies);
    await page.goto(`${BASE_URL}/ints/agent/SMSCDRReports`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const url = page.url();
    if (/\/login/i.test(url)) {
      dlog('[msi-bot] cookie auth: redirected to /login → expired');
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
      dlog('[msi-bot] cookie auth: no logged-in content');
      _cookieFailStreak++;
      maybeAlertCookieExpired('no logged-in content on page');
      return false;
    }
    loggedIn = true;
    status.loggedIn = true;
    status.lastLoginAt = Math.floor(Date.now() / 1000);
    _cdrReady = true;
    _cookieFailStreak = 0;
    console.log('[msi-bot] ✓ logged in via saved cookies (skipped captcha)');
    logEvent('success', 'Logged in via saved session cookies (no captcha needed)');
    return true;
  } catch (e) {
    dwarn('[msi-bot] cookie auth failed:', e.message);
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
  logEvent('error', `MSI cookies expired (${_cookieFailStreak} consecutive fails) — refresh needed`);
}

async function login() {
  // 1) Try cookie auth first — instant, no captcha
  if (await tryCookieAuth()) return;

  // 2) Fall back to form login (math captcha)
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await loginOnce();
      if (attempt > 1) logEvent('success', `Login OK on attempt ${attempt}`);
      // Save fresh cookies so next restart skips captcha
      try {
        const fresh = await page.cookies();
        if (fresh && fresh.length) {
          db.prepare(`
            INSERT INTO settings (key, value, updated_at) VALUES ('msi_cookies', ?, strftime('%s','now'))
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s','now')
          `).run(JSON.stringify(fresh));
          dlog(`[msi-bot] saved ${fresh.length} fresh cookies for next session`);
          logEvent('success', `Saved ${fresh.length} fresh session cookies`);
        }
      } catch (e) { dwarn('[msi-bot] failed to save fresh cookies:', e.message); }
      return;
    } catch (e) {
      lastErr = e;
      console.warn(`[msi-bot] login attempt ${attempt}/3 failed: ${e.message}`);
      logEvent('warn', `Login attempt ${attempt}/3 failed: ${e.message}`);
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr || new Error('MSI login failed after 3 attempts');
}

// ---- Scrape MySMSNumbers (number pool) ----
async function scrapeNumbers() {
  await page.goto(`${BASE_URL}/ints/agent/MySMSNumbers`, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null);
  if (/\/login/i.test(page.url())) { loggedIn = false; return []; }

  // Bump page-size to max
  await page.evaluate(() => {
    const sel = document.querySelector('select[name$="_length"], .dataTables_length select');
    if (!sel) return;
    const opts = Array.from(sel.options || []);
    const all = opts.find(o => /all/i.test(o.text) || o.value === '-1');
    if (all) { sel.value = all.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return; }
    const maxNum = opts.filter(o => /^\d+$/.test(o.value)).map(o => +o.value).sort((a, b) => b - a)[0];
    if (maxNum) { sel.value = String(maxNum); sel.dispatchEvent(new Event('change', { bubbles: true })); }
  }).catch(() => {});
  await new Promise(r => setTimeout(r, 800));

  const extractRows = () => page.evaluate(() => {
    const out = [];
    document.querySelectorAll('table tbody tr').forEach((row) => {
      const cells = Array.from(row.querySelectorAll('td')).map(c => c.innerText.trim());
      if (!cells.length) return;
      // Find phone (8-15 digits) and range (text label)
      const phone = cells.find(t => /^\+?\d{8,15}$/.test(t.replace(/[\s-]/g, '')));
      if (!phone) return;
      const range = cells.find(t => /[A-Za-z]/.test(t) && t.length < 60 && t !== phone && !/payout|weekly|monthly|sd\s*:|sw\s*:/i.test(t));
      out.push({ phone_number: phone.replace(/[\s-]/g, ''), operator: range || null });
    });
    return out;
  });

  const seen = new Set();
  const all = [];
  const pushUnique = (rows) => {
    for (const r of rows) {
      if (seen.has(r.phone_number)) continue;
      seen.add(r.phone_number);
      all.push(r);
    }
  };
  pushUnique(await extractRows());

  // Paginate
  for (let i = 0; i < 200; i++) {
    const clicked = await page.evaluate(() => {
      const isDisabled = (el) => {
        if (!el) return true;
        const cls = (el.className || '') + ' ' + ((el.parentElement && el.parentElement.className) || '');
        if (/disabled/i.test(cls)) return true;
        if (el.getAttribute('aria-disabled') === 'true') return true;
        return false;
      };
      let next = document.querySelector('a.paginate_button.next, li.next > a, a[rel="next"]');
      if (!next) {
        next = Array.from(document.querySelectorAll('a, button'))
          .find(a => /^(next|›|»)$/i.test((a.innerText || '').trim()));
      }
      if (!next || isDisabled(next)) return false;
      next.click();
      return true;
    });
    if (!clicked) break;
    await new Promise(r => setTimeout(r, 600));
    const before = all.length;
    pushUnique(await extractRows());
    if (all.length === before) break;
  }
  return all;
}

// ---- Scrape SMS CDR Reports (OTPs) ----
// MSI auto-loads with TODAY's date range. We just reload for fresh data.
let _cdrReady = false;

async function scrapeOtps() {
  if (!page) return [];
  const onCdr = /SMSCDRReports/i.test(page.url());
  if (!onCdr || !_cdrReady) {
    await page.goto(`${BASE_URL}/ints/agent/SMSCDRReports`, { waitUntil: 'networkidle2', timeout: 25000 });
    if (/\/login/i.test(page.url())) { loggedIn = false; _cdrReady = false; return []; }
    // Bump page size to 100
    await page.evaluate(() => {
      const sel = document.querySelector('select[name$="_length"], .dataTables_length select');
      if (!sel) return;
      const opts = Array.from(sel.options || []);
      const pick = opts.find(o => +o.value === 100) || opts.find(o => +o.value === 50);
      if (pick) { sel.value = pick.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 1200));
    _cdrReady = true;
  } else {
    // Subsequent polls — click Show Report (if present) or just re-fetch via reload
    const clicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button, input[type="submit"], a.btn'))
        .find(b => /show\s*report/i.test((b.innerText || b.value || '').trim()));
      if (btn) { btn.click(); return true; }
      return false;
    }).catch(() => false);
    if (clicked) {
      await new Promise(r => setTimeout(r, 1500));
    } else {
      // Fallback: light reload
      await page.reload({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
    }
  }

  const rows = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('table tbody tr').forEach((row) => {
      const cells = Array.from(row.querySelectorAll('td')).map(c => c.innerText.trim());
      if (!cells.length || cells.length < 4) return;
      // Skip "Total SMS" / footer rows
      if (/^total\s*sms/i.test(cells[0] || '')) return;
      // Find phone, sms text, date, cli
      const phone = cells.find(t => /^\+?\d{8,15}$/.test(t.replace(/[\s-]/g, '')));
      if (!phone) return;
      const dateCell = cells.find(t => /\d{4}-\d{2}-\d{2}/.test(t));
      // SMS text = the longest cell containing letters or a 4+ digit code
      let smsText = '';
      for (const c of cells) {
        if (c === phone) continue;
        if (c.length > smsText.length && /[a-zA-Z]/.test(c)) smsText = c;
      }
      if (!smsText) {
        // fallback: longest non-phone cell
        for (const c of cells) {
          if (c === phone) continue;
          if (c.length > smsText.length) smsText = c;
        }
      }
      // CLI = short alpha label cell that is NOT the range/sms (often "AUB Cards" etc.)
      const cliCell = cells.find(t => /[A-Za-z]/.test(t) && t.length < 30 && t !== phone && t !== smsText && !/^\d/.test(t));
      // Extract OTP code: 3-8 digit number in SMS body
      const otpMatch = smsText.match(/\b(\d{3,8})\b/);
      out.push({
        phone_number: phone.replace(/[\s-]/g, ''),
        otp_code: otpMatch ? otpMatch[1] : null,
        sms_text: smsText,
        cli: cliCell || null,
        date_str: dateCell || null,
      });
    });
    return out;
  }).catch(() => []);

  // Convert dates
  return rows.map(r => ({
    ...r,
    date_ts: r.date_str ? Math.floor(new Date(r.date_str.replace(' ', 'T') + 'Z').getTime() / 1000) || null : null,
  })).filter(r => r.otp_code);
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
  const otps = await scrapeOtps().catch((e) => { dwarn('[msi-bot] scrapeOtps:', e.message); return []; });
  status.lastScrapeAt = Math.floor(Date.now() / 1000);
  status.totalScrapes++;
  if (!otps.length) { status.lastScrapeOk = true; return 0; }
  status.lastScrapeOk = true;

  // Cache all
  for (const o of otps) _addToCache(o.phone_number, o);

  // Find active allocations awaiting OTP
  const active = db.prepare(`
    SELECT id, phone_number, allocated_at FROM allocations
    WHERE provider='msi' AND status='active' AND otp IS NULL
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
        WHERE provider='msi' AND phone_number=? AND otp=? AND id<>?
        LIMIT 1
      `).get(a.phone_number, cached.otp_code, a.id);
      if (dup) continue;
    }
    try {
      await markOtpReceived(a, cached.otp_code, cached.cli || null);
      status.otpsDeliveredTotal++;
      delivered++;
      console.log(`[msi-bot] OTP delivered: ${a.phone_number} → ${cached.otp_code} (alloc#${a.id})`);
      logEvent('success', `OTP delivered to ${a.phone_number}`, { otp: cached.otp_code, alloc: a.id });
    } catch (e) {
      dwarn(`[msi-bot] markOtpReceived failed for ${a.phone_number}:`, e.message);
    }
  }
  return delivered;
}

// ---- Pool sync (numbers) ----
function ensurePoolUser() {
  let u = db.prepare("SELECT id FROM users WHERE username = '__msi_pool__'").get();
  if (!u) {
    const r = db.prepare(`INSERT INTO users (username, password_hash, role, status) VALUES ('__msi_pool__', '!', 'agent', 'suspended')`).run();
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

  const exists = db.prepare("SELECT 1 FROM allocations WHERE provider='msi' AND phone_number=? LIMIT 1");
  const ins = db.prepare(`
    INSERT INTO allocations (user_id, provider, phone_number, country_code, operator, status, allocated_at)
    VALUES (?, 'msi', ?, ?, ?, 'pool', strftime('%s','now'))
  `);
  const poolRows = db.prepare("SELECT id, phone_number FROM allocations WHERE provider='msi' AND status='pool'").all();
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
    status.lastError = 'MSI bot disabled';
    status.lastErrorAt = now;
    logEvent('warn', 'Start skipped — bot disabled');
    console.log('✗ MSI bot disabled (set MSI_ENABLED=true or enable from admin panel)');
    return false;
  }
  if (!USERNAME || !PASSWORD) {
    console.warn('✗ MSI bot: credentials not set');
    status.lastError = 'MSI credentials not set';
    status.lastErrorAt = now;
    status.running = false;
    status.loggedIn = false;
    logEvent('error', 'Start skipped — MSI credentials not set');
    return false;
  }
  if (otpTimer) { clearTimeout(otpTimer); otpTimer = null; }
  if (numbersTimer) { clearInterval(numbersTimer); numbersTimer = null; }

  // Recover any orphaned 'claiming' rows back to pool
  try {
    const r = db.prepare("UPDATE allocations SET status='pool' WHERE provider='msi' AND status='claiming'").run();
    if (r.changes) console.log(`[msi-bot] recovered ${r.changes} 'claiming' allocations → 'pool'`);
  } catch (_) {}

  status.running = true;
  status.lastError = null;
  status.lastErrorAt = null;
  _stopped = false;
  console.log(`✓ MSI bot starting (OTP poll ${OTP_INTERVAL}s, number sync ${NUMBERS_INTERVAL}s, headless=${HEADLESS}, base=${BASE_URL})`);

  // Initial: login + first pool sync
  setTimeout(async () => {
    try {
      await ensureBrowser();
      if (!loggedIn) await login();
      console.log('[msi-bot] initial login complete — running first pool sync');
      await syncPool().catch(e => console.warn('[msi-bot] initial sync failed:', e.message));
    } catch (e) {
      console.error('[msi-bot] initial login failed:', e.message);
      status.lastError = e.message;
      status.lastErrorAt = Math.floor(Date.now() / 1000);
      logEvent('error', 'Initial login failed: ' + e.message);
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
        if (delivered > 0) console.log(`[msi-bot] poll delivered ${delivered} OTP(s) in ${Date.now() - t0}ms`);
      } catch (e) {
        status.consecFail++;
        status.lastError = e.message;
        status.lastErrorAt = Math.floor(Date.now() / 1000);
        status.lastScrapeOk = false;
        console.warn(`[msi-bot] otp-poll fail #${status.consecFail}:`, e.message);
        logEvent('warn', `OTP poll failed (#${status.consecFail}): ${e.message}`);
        // Recycle browser after 3 consecutive fails
        if (status.consecFail >= 3) {
          console.warn('[msi-bot] 3 consecutive fails — recycling browser');
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
    catch (e) { console.warn('[msi-bot] periodic syncPool failed:', e.message); }
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
