// IMS Browser Bot — runs a headless Chrome that stays logged into imssms.org
// and scrapes the manager's numbers + OTP CDRs at a fixed interval.
//
// Real IMS panel structure (verified by user screenshot):
//   /login           → form with username, password, and a CALCULATOR CAPTCHA (e.g. "5 + 3 = ?")
//   /client/SMSCDRStats  → "SMS CDR Stats" (DATE | RANGE | NUMBER | CLI | SMS | CURRENCY | MY PAYOUT)
//                           The "SMS" cell contains the OTP text — we extract digits.
//   /client/MySMSNumbers → "My SMS Numbers" (RANGE | PREFIX | NUMBER | MY PAYTERM | MY PAYOUT | LIMITS)
//
// Required env (backend/.env on VPS):
//   IMS_ENABLED=true
//   IMS_USERNAME=Shovonkhan7
//   IMS_PASSWORD=your_password
//   IMS_CHROME_PATH=/usr/bin/chromium-browser   (or empty for puppeteer's bundled chrome)
//   IMS_HEADLESS=true
//   IMS_SCRAPE_INTERVAL=8

const fs = require('fs');
const db = require('../lib/db');
const { markOtpReceived } = require('../routes/numbers');

// Quiet logger — production only prints important events; dev prints all.
const QUIET = process.env.NODE_ENV === 'production';
const dlog = (...a) => { if (!QUIET) console.log(...a); };
const dwarn = (...a) => { if (!QUIET) console.warn(...a); };

// Read DB-stored override (settings table); falls back to .env
function readSetting(key) {
  try { return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || null; }
  catch (_) { return null; }
}
function resolveCreds() {
  const dbEnabled = readSetting('ims_enabled');
  const dbUser = readSetting('ims_username');
  const dbPass = readSetting('ims_password');
  const dbBase = readSetting('ims_base_url');
  return {
    ENABLED: (dbEnabled !== null ? dbEnabled : (process.env.IMS_ENABLED || 'false')).toString().toLowerCase() === 'true',
    BASE_URL: (dbBase || process.env.IMS_BASE_URL || 'https://www.imssms.org').replace(/\/$/, ''),
    USERNAME: dbUser || process.env.IMS_USERNAME || '',
    PASSWORD: dbPass || process.env.IMS_PASSWORD || '',
  };
}
let { ENABLED, BASE_URL, USERNAME, PASSWORD } = resolveCreds();
const HEADLESS = String(process.env.IMS_HEADLESS || 'true').toLowerCase() !== 'false';
const CHROME_PATH = process.env.IMS_CHROME_PATH || undefined;
// Heavy scrape interval — minimum 60s. The full number-list pagination on imssms.org
// can take 30-90s with 17k+ rows, so anything lower causes ticks to overlap and deadlock.
const INTERVAL = Math.max(60, +(process.env.IMS_SCRAPE_INTERVAL || 60));

let browser = null;
let page = null;
let busy = false;          // heavy tick busy
let otpBusy = false;       // fast-poll busy (independent — fixes deadlock when heavy tick takes >8s)
let tickStartedAt = 0;     // wall-clock when current tick began (for stuck-detection)
let consecFail = 0;
let loggedIn = false;
let emptyStreak = 0;        // consecutive scrapes returning 0 numbers
let scrapeTimer = null;     // for graceful stop
let otpTimer = null;        // fast OTP-only poll loop (now setTimeout-based, adaptive)
let _scheduledStop = false; // signals adaptive _scheduleNextPoll() chain to stop
const EMPTY_LIMIT = +(process.env.IMS_EMPTY_LIMIT || 10);
let lastLowPoolAlertAt = 0;   // unix seconds — debounce low-pool notifications
let _cookieFailStreak = 0;    // consecutive cookie-auth failures (resets on success)
let _lastCookieExpiryAlertAt = 0; // debounce cookie-expiry alerts (1 per 6h)

// Live status (read by /api/admin/ims-status)
const status = {
  enabled: false,
  running: false,
  loggedIn: false,
  lastLoginAt: null,        // unix seconds
  lastScrapeAt: null,       // unix seconds
  lastScrapeOk: false,
  lastError: null,          // string
  lastErrorAt: null,
  totalScrapes: 0,
  numbersScrapedTotal: 0,   // sum of numbers seen across scrapes
  numbersAddedTotal: 0,     // newly inserted to pool
  otpsDeliveredTotal: 0,    // OTPs successfully matched & credited
  consecFail: 0,
  baseUrl: '',
  intervalSec: 0,
  otpIntervalSec: 0,
};

// Ring buffer of recent scrape activity (last 20 events)
const events = [];
function logEvent(level, message, meta) {
  events.unshift({ ts: Math.floor(Date.now() / 1000), level, message, meta: meta || null });
  if (events.length > 20) events.length = 20;
}

function getStatus() {
  try {
    const poolSize = db.prepare("SELECT COUNT(*) c FROM allocations WHERE provider='ims' AND status='pool'").get().c;
    const claimingSize = db.prepare("SELECT COUNT(*) c FROM allocations WHERE provider='ims' AND status='claiming'").get().c;
    const activeAssigned = db.prepare("SELECT COUNT(*) c FROM allocations WHERE provider='ims' AND status='active'").get().c;
    const otpReceived = db.prepare("SELECT COUNT(*) c FROM allocations WHERE provider='ims' AND status='received'").get().c;
    const hasCookies = !!readSetting('ims_cookies');
    return {
      ...status, poolSize, claimingSize, activeAssigned, otpReceived,
      emptyStreak, emptyLimit: EMPTY_LIMIT, events: events.slice(),
      cookieFailStreak: _cookieFailStreak, hasCookies,
      maxRowsScraped: _maxRowsSeen,
      otpCacheSize: recentOtpCache.size,
    };
  } catch (_) {
    return {
      ...status, poolSize: 0, claimingSize: 0, activeAssigned: 0, otpReceived: 0,
      emptyStreak, emptyLimit: EMPTY_LIMIT, events: events.slice(),
      cookieFailStreak: _cookieFailStreak, hasCookies: false,
      maxRowsScraped: _maxRowsSeen, otpCacheSize: 0,
    };
  }
}

async function restart() {
  logEvent('info', 'Restart requested by admin');
  await stop();
  consecFail = 0;
  status.lastError = null;
  status.lastErrorAt = null;
  setTimeout(() => {
    try { start(); logEvent('success', 'Bot restarted'); }
    catch (e) { logEvent('error', 'Restart failed: ' + e.message); }
  }, 1000);
  return true;
}

async function ensureBrowser() {
  if (browser && page) return;
  // Use puppeteer-extra + stealth plugin to bypass Cloudflare bot detection.
  // Falls back to plain puppeteer if the plugin packages aren't installed yet.
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
    // Bumped from default 30s → 180s. Heavy CDR responses + occasional IMS
    // server lag can exceed 90s during page.evaluate() calls, causing
    // "Runtime.callFunctionOn timed out" + Target closed crashes. Show-Report
    // click itself is wrapped in a 20s race below, so this only protects against
    // truly catastrophic upstream stalls.
    protocolTimeout: 240000,
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
  // Real Chrome UA — Cloudflare blocks anything containing "Bot", "Headless", or unusual UAs
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  loggedIn = false;
}

// ---- Calculator captcha solver ----
// Reads the captcha label, evaluates arithmetic, returns the answer string.
// Handles: "5 + 3 = ?", "12-4=?", "7 × 2 = ?", "8 / 2 = ?",
//          "What is 5+3", "5 + 3 + 2 = ?", "(4+2)*3=?", multi-line / noisy text.
// Uses a SAFE arithmetic-only evaluator (no eval) to avoid code injection
// since the input comes from a remote page.
function solveCaptchaText(text) {
  if (!text) return null;
  // Normalize unicode operators / spaces
  const norm = String(text)
    .replace(/[×x✕✖⨯·]/gi, '*')
    .replace(/[÷⁄]/g, '/')
    .replace(/[−–—]/g, '-')
    .replace(/[\u00A0\u2000-\u200B]/g, ' ');
  // Strip the trailing "= ?" / "= ? :" / "?" so we focus on the LHS.
  // Then try to find a contiguous arithmetic expression with 2+ operands.
  // Examples that should match: "5 + 3", "5 + 3 + 2", "(4+2)*3", "12 - 4"
  const lhs = norm.split(/=/)[0] || norm;
  // Greedy: longest run of digits, ops, parens, dots, spaces.
  const exprMatches = lhs.match(/[-+]?\s*\(?\s*\d+(?:\.\d+)?(?:\s*[+\-*/]\s*\(?\s*\d+(?:\.\d+)?\)?)+/g);
  if (!exprMatches || !exprMatches.length) return null;
  // Pick the LONGEST candidate (most likely the full captcha expression).
  const expr = exprMatches.sort((a, b) => b.length - a.length)[0];
  // Safe eval: ensure ONLY digits, operators, parens, dots, spaces remain.
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

async function loginOnce() {
  dlog('[ims-bot] navigating to login page');
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle2', timeout: 30000 });

  // Fill username + password — IMS may use any of: name, id, placeholder, autocomplete
  // Try a wide selector list, then fall back to "first visible text input + first password input".
  const userSel = 'input[name="username"], input[name="user"], input[name="email"], input[name="login"], input[id="username"], input[id="user"], input[id="email"], input[autocomplete="username"], input[placeholder*="user" i], input[placeholder*="email" i], input[type="text"]:not([readonly])';
  const passSel = 'input[name="password"], input[id="password"], input[type="password"]';

  // Wait for the form to mount (any input at all)
  try {
    await page.waitForSelector('input', { timeout: 20000 });
  } catch (e) {
    // Dump page so we can see what IMS actually returned (Cloudflare? wrong URL? maintenance?)
    try {
      const fs = require('fs');
      const path = require('path');
      const html = await page.content();
      const url = page.url();
      const title = await page.title().catch(() => '');
      const dumpPath = path.join(__dirname, '..', 'ims-login-dump.html');
      fs.writeFileSync(dumpPath, `<!-- url=${url} title=${title} -->\n${html}`);
      console.error(`[ims-bot] LOGIN PAGE HAS NO <input> — dumped to ${dumpPath} (url=${url}, title=${title})`);
      logEvent('error', `Login page has no input. URL=${url} Title=${title}. See backend/ims-login-dump.html`);
    } catch (_) {}
    throw e;
  }

  // Resolve the actual selectors from inside the page so we never rely on strict CSS matching
  const resolved = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input'));
    const visible = inputs.filter(i => i.offsetParent !== null && i.type !== 'hidden');
    const pass = visible.find(i => i.type === 'password');
    const user = visible.find(i => {
      if (i === pass) return false;
      if (i.type === 'password') return false;
      const meta = `${i.name || ''} ${i.id || ''} ${i.placeholder || ''} ${i.autocomplete || ''}`.toLowerCase();
      return /user|email|login|account/.test(meta) || i.type === 'text' || !i.type;
    });
    const sel = (el) => el?.id ? `#${CSS.escape(el.id)}` : el?.name ? `input[name="${el.name}"]` : null;
    return { userSel: sel(user), passSel: sel(pass) };
  });
  const finalUser = resolved.userSel || userSel;
  const finalPass = resolved.passSel || passSel;
  await page.click(finalUser, { clickCount: 3 }).catch(() => {});
  await page.type(finalUser, USERNAME, { delay: 25 });
  await page.click(finalPass, { clickCount: 3 }).catch(() => {});
  await page.type(finalPass, PASSWORD, { delay: 25 });

  // Find captcha question (e.g. "What is 6 + 5 = ? :" or "5 + 3 + 2 = ?")
  const { captchaText, captchaSel } = await page.evaluate(() => {
    // Defensive: page may be mid-navigation — bail safely if body is null.
    if (!document || !document.body) return { captchaText: null, captchaSel: null };
    // 1) Find the math expression anywhere on the page.
    //    Supports 2+ operands: "5+3=?", "5+3+2=?", "(4+2)*3=?".
    const allText = (document.body.innerText || document.body.textContent || '');
    const exprRe = /\(?\s*-?\d+\s*(?:[+\-x×*/÷]\s*\(?\s*-?\d+\s*\)?\s*){1,5}=\s*\?/i;
    const mathMatch = allText.match(exprRe);
    if (!mathMatch) return { captchaText: null, captchaSel: null };
    const expr = mathMatch[0];

    // 2) Locate the DOM node containing that text
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node, host = null;
    while ((node = walker.nextNode())) {
      if (exprRe.test(node.nodeValue || '')) { host = node.parentElement; break; }
    }

    // 3) Find the nearest answer input — search ancestors → look inside their inputs
    let answerInput = null;
    let cur = host;
    for (let depth = 0; depth < 6 && cur && !answerInput; depth++) {
      const candidates = cur.querySelectorAll('input[type="text"], input[type="number"], input:not([type])');
      for (const inp of candidates) {
        if (inp.type === 'hidden' || inp.type === 'password') continue;
        const nm = (inp.name || '').toLowerCase();
        if (nm === 'username' || nm === 'user' || nm === 'email' || nm === 'password') continue;
        answerInput = inp; break;
      }
      cur = cur.parentElement;
    }

    // 4) Fallback: any visible non-auth input that comes AFTER the captcha label in DOM order
    if (!answerInput) {
      const allInputs = Array.from(document.querySelectorAll('input'));
      for (const inp of allInputs) {
        if (inp.type === 'hidden' || inp.type === 'password') continue;
        const nm = (inp.name || '').toLowerCase();
        if (nm === 'username' || nm === 'user' || nm === 'email') continue;
        // Pick the LAST text/number input on the form (captcha is usually last)
        answerInput = inp;
      }
    }

    if (!answerInput) return { captchaText: expr, captchaSel: null };
    // Build a unique selector
    let sel = null;
    if (answerInput.id) sel = `#${CSS.escape(answerInput.id)}`;
    else if (answerInput.name) sel = `input[name="${answerInput.name}"]`;
    else {
      // last-input fallback
      const all = Array.from(document.querySelectorAll('input'));
      sel = `input:nth-of-type(${all.indexOf(answerInput) + 1})`;
    }
    return { captchaText: expr, captchaSel: sel };
  });

  if (captchaText && captchaSel) {
    const answer = solveCaptchaText(captchaText);
    if (answer) {
      dlog(`[ims-bot] captcha "${captchaText.replace(/\s+/g,' ').trim().slice(0,60)}" → ${answer}`);
      await page.click(captchaSel, { clickCount: 3 }).catch(() => {});
      await page.type(captchaSel, answer, { delay: 25 });
    } else {
      dwarn('[ims-bot] captcha detected but could not solve:', captchaText.slice(0, 100));
    }
  } else {
    dlog('[ims-bot] no captcha detected on login page');
  }

  // Submit
  await Promise.all([
    page.evaluate(() => {
      try {
        const btn = document.querySelector('button[type="submit"], input[type="submit"]') ||
                    Array.from(document.querySelectorAll('button')).find(b => /login|sign in/i.test((b && b.innerText) || ''));
        if (btn) btn.click();
      } catch (_) { /* swallow — wait-for-nav will handle outcome */ }
    }),
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null),
  ]);

  // Detect successful login: URL no longer contains /login, or dashboard text appears
  const url = page.url();
  const ok = !/\/login/i.test(url);
  loggedIn = ok;
  status.loggedIn = ok;
  if (ok) status.lastLoginAt = Math.floor(Date.now() / 1000);
  dlog(`[ims-bot] login ${ok ? '✓' : '✗'} (url=${url})`);
  if (!ok) {
    // Common cause: wrong captcha. Throw so wrapper retries.
    throw new Error('IMS login failed (likely captcha) — will retry');
  }
}

// ---- Session cookie injection (bypasses captcha entirely) ----
// Admin pastes browser cookies (from DevTools → Application → Cookies) into the
// admin panel. We inject them into puppeteer BEFORE attempting login. If they're
// still valid, we skip the captcha-protected login form completely.
//
// Accepts two formats:
//   1) JSON array (Chrome "EditThisCookie" export): [{name,value,domain,path,...}]
//   2) Cookie header string: "name1=value1; name2=value2; ..."
function parseCookies(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const txt = raw.trim();
  if (!txt) return [];
  // Try JSON first
  if (txt.startsWith('[') || txt.startsWith('{')) {
    try {
      const parsed = JSON.parse(txt);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      return arr.filter(c => c && c.name && c.value).map(c => ({
        name: c.name,
        value: String(c.value),
        domain: c.domain || '.imssms.org',
        path: c.path || '/',
        httpOnly: !!c.httpOnly,
        secure: c.secure !== false,
        sameSite: c.sameSite || 'Lax',
      }));
    } catch (_) { /* fall through to header-string parsing */ }
  }
  // Header-string format: "k1=v1; k2=v2"
  const out = [];
  for (const pair of txt.split(/;\s*/)) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    out.push({
      name,
      value,
      domain: '.imssms.org',
      path: '/',
      httpOnly: false,
      secure: true,
      sameSite: 'Lax',
    });
  }
  return out;
}

async function tryCookieAuth() {
  const raw = readSetting('ims_cookies');
  if (!raw) return false;
  const cookies = parseCookies(raw);
  if (!cookies.length) {
    dwarn('[ims-bot] saved cookies present but parse returned 0 entries');
    return false;
  }
  try {
    // Set cookies at the browser level (works for any path on the domain)
    await page.setCookie(...cookies);
    // Visit a protected page to verify the session is valid
    await page.goto(`${BASE_URL}/client/SMSCDRStats`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const url = page.url();
    if (/\/login/i.test(url)) {
      dlog('[ims-bot] cookie auth: redirected to /login → cookies expired');
      _cookieFailStreak++;
      maybeAlertCookieExpired('redirected to /login');
      return false;
    }
    // Confirm we have actual logged-in content (table or dashboard)
    const hasContent = await page.evaluate(() => {
      const t = document.querySelectorAll('table').length;
      const txt = (document.body.innerText || '').toLowerCase();
      return t > 0 || /logout|dashboard|sms/i.test(txt);
    }).catch(() => false);
    if (!hasContent) {
      dlog('[ims-bot] cookie auth: page loaded but no logged-in content');
      _cookieFailStreak++;
      maybeAlertCookieExpired('no logged-in content on page');
      return false;
    }
    loggedIn = true;
    status.loggedIn = true;
    status.lastLoginAt = Math.floor(Date.now() / 1000);
    _cdrPageReady = true;
    _cookieFailStreak = 0; // success — reset
    console.log('[ims-bot] ✓ logged in via saved cookies (skipped captcha)');
    logEvent('success', 'Logged in via saved session cookies (no captcha needed)');
    return true;
  } catch (e) {
    dwarn('[ims-bot] cookie auth failed:', e.message);
    _cookieFailStreak++;
    maybeAlertCookieExpired(e.message);
    return false;
  }
}

// Fires red notification once cookie auth has failed 3+ times in a row,
// throttled to once per 6 hours so we don't spam admins.
function maybeAlertCookieExpired(reason) {
  if (_cookieFailStreak < 3) return;
  const now = Math.floor(Date.now() / 1000);
  if (now - _lastCookieExpiryAlertAt < 6 * 3600) return;
  _lastCookieExpiryAlertAt = now;
  logEvent('error', `IMS cookies expired (${_cookieFailStreak} consecutive fails) — refresh needed`);
  notifyAdmins(
    '🍪 IMS Cookies Expired',
    `Saved IMS session cookies have stopped working (${_cookieFailStreak} consecutive failures: ${reason}). Please log into imssms.org manually, copy the new PHPSESSID cookie, and paste it into Admin → IMS Bot → Bypass Captcha section.`,
    'error'
  );
}

// Public login() — tries saved cookies first, then falls back to form login
// with up to 3 captcha attempts. IMS serves a fresh captcha each page load,
// so a wrong-captcha failure on attempt N often succeeds on N+1.
async function login() {
  // 1) Try cookie auth first — instant if valid, no captcha needed
  if (await tryCookieAuth()) return;

  // 2) Fall back to full form login with retries
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await loginOnce();
      if (attempt > 1) {
        console.log(`[ims-bot] login OK on attempt ${attempt}`);
        logEvent('success', `Login OK on attempt ${attempt}`);
      }
      // After successful form login, save fresh cookies so next restart skips captcha
      try {
        const fresh = await page.cookies();
        if (fresh && fresh.length) {
          const json = JSON.stringify(fresh);
          db.prepare(`
            INSERT INTO settings (key, value, updated_at) VALUES ('ims_cookies', ?, strftime('%s','now'))
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s','now')
          `).run(json);
          dlog(`[ims-bot] saved ${fresh.length} fresh cookies for next session`);
        }
      } catch (e) { dwarn('[ims-bot] failed to save fresh cookies:', e.message); }
      return;
    } catch (e) {
      lastErr = e;
      console.warn(`[ims-bot] login attempt ${attempt}/3 failed: ${e.message}`);
      logEvent('warn', `Login attempt ${attempt}/3 failed: ${e.message}`);
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr || new Error('IMS login failed after 3 attempts');
}

// ---- Scrape SMS Numbers page (the manager's available numbers) ----
// Walks ALL pagination pages so 5K+ numbers come into the pool in one tick.
async function scrapeNumbers() {
  await page.goto(`${BASE_URL}/client/MySMSNumbers`, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null);
  if (/\/login/i.test(page.url())) { loggedIn = false; return []; }

  // Try to switch the table page-size to "All" / max value if available
  await page.evaluate(() => {
    const sel = document.querySelector('select[name$="_length"], select.form-control-sm, select[aria-controls]');
    if (!sel) return;
    const opts = Array.from(sel.options).map(o => ({ v: o.value, t: o.text.trim().toLowerCase() }));
    const all = opts.find(o => o.t === 'all' || o.v === '-1');
    if (all) { sel.value = all.v; sel.dispatchEvent(new Event('change', { bubbles: true })); return; }
    const maxNum = opts.filter(o => /^\d+$/.test(o.v)).map(o => +o.v).sort((a, b) => b - a)[0];
    if (maxNum) { sel.value = String(maxNum); sel.dispatchEvent(new Event('change', { bubbles: true })); }
  }).catch(() => {});
  await new Promise(r => setTimeout(r, 800));

  const extractRows = () => page.evaluate(() => {
    const out = [];
    document.querySelectorAll('table tbody tr').forEach((row) => {
      const cells = Array.from(row.querySelectorAll('td')).map(c => c.innerText.trim());
      if (!cells.length) return;
      const phone = cells.find(t => /^\+?\d{8,15}$/.test(t.replace(/[\s-]/g, '')));
      if (!phone) return;
      const range = cells.find(t => /[A-Za-z]/.test(t) && t.length < 60 && t !== phone);
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

  // Paginate: click "Next" until disabled, no growth, or 200-page safety cap
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
    await new Promise(r => setTimeout(r, 700));
    const before = all.length;
    pushUnique(await extractRows());
    if (all.length === before) break;
  }

  return all;
}

// ---- Scrape SMS CDRs (the OTP/SMS log) ----
// Real columns from imssms.org/client/SMSCDRStats:
//   DATE | RANGE | NUMBER | CLI | SMS | CURRENCY | MY PAYOUT
// IMS shows newest entries first (sorted by DATE desc) — we preserve that order
// so the latest OTP wins when the same number appears multiple times.
// Track which page the persistent browser is currently sitting on.
// We navigate to CDR ONCE — afterwards we just call page.reload() to refresh data.
// IMS auto-loads the CDR table on page load (no "Show Report" click needed).
let _cdrPageReady = false;
let _lastShowReportAt = 0;     // wall-clock ms of last successful Show Report click — used to enforce IMS's 15s minimum interval
let _lastPageSizeCheckAt = 0;  // wall-clock ms of last page-size verification (re-bump if IMS reset to default)
let _scrapeInFlight = null;    // Promise mutex — prevents parallel scrapeOtps() calls (was causing 90s overlap + race conditions)
let _maxRowsSeen = 0;          // peak row count from any single scrape — used by status/burst metrics

async function scrapeOtps() {
  // Mutex: if a scrape is already running, return the SAME promise instead
  // of starting a second one. Prevents two evaluate() calls hitting IMS in
  // parallel (which triggers the 15s rate-limit warning) and avoids the
  // 60s+ "navigation/refresh done" stalls we saw in production logs.
  if (_scrapeInFlight) return _scrapeInFlight;
  _scrapeInFlight = (async () => {
    if (!page) throw new Error('page not ready');
    const _t0 = Date.now();
    const _step = (label) => console.log(`[ims-bot][scrape] ${label} (+${Date.now() - _t0}ms)`);
    const onCdrPage = /SMSCDRStats/i.test(page.url());
    _step(`start onCdrPage=${onCdrPage} cdrReady=${_cdrPageReady}`);

  if (!onCdrPage || !_cdrPageReady) {
    // First visit (or after logout) — full navigation.
    try {
      await page.goto(`${BASE_URL}/client/SMSCDRStats`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch (e) {
      _cdrPageReady = false;
      throw new Error('CDR page navigation failed: ' + e.message);
    }
    if (/\/login/i.test(page.url())) { loggedIn = false; _cdrPageReady = false; return []; }

    // LIVE-VERIFIED behavior of /client/SMSCDRStats:
    //   • Page AUTO-LOADS today's CDRs (00:00 → 23:59) on first visit.
    //   • Default page size = 25. We bump to "All" via the length dropdown so
    //     a single scrape covers 100s of OTPs (no manual pagination).
    //   • Clicking "Show Report" triggers a fresh AJAX. Hitting it faster than
    //     15s shows a rate-limit warning row — outer poll loop is ≥18s.
    try {
      // Wait for the DataTable wrapper itself — confirms AJAX layer is ready
      await page.waitForSelector('table tbody, .dataTables_wrapper', { timeout: 10000 });
      // Aggressively try to bump page size to maximum so a single scrape covers
      // 100s of OTPs (critical for burst load — 100+ agents requesting at once).
      // Returns: { ok, picked, options, currentRows } for diagnostics.
      const sizeResult = await page.evaluate(() => {
        const sel = document.querySelector('select[name$="_length"], select.dataTable-selector, .dataTables_length select');
        if (!sel) return { ok: false, reason: 'no length selector found' };
        const opts = Array.from(sel.options || []).map(o => ({ text: o.text, value: o.value }));
        // Preference order: "All" → 1000 → 500 → 250 → 100 → highest numeric
        const findOpt = (pred) => Array.from(sel.options || []).find(pred);
        // Cap at 500 — "All"/1000 makes DataTables render 12k+ rows which
        // hangs page.evaluate() (Runtime.callFunctionOn timeout). 500 is a
        // safe sweet spot: handles 100+ agent burst, finishes in <2s.
        let pick = findOpt(o => +o.value === 500)
                || findOpt(o => +o.value === 250)
                || findOpt(o => +o.value === 100)
                || findOpt(o => +o.value === 50);
        if (!pick) {
          // No preferred option — pick highest numeric value but cap at 500
          const nums = Array.from(sel.options || [])
            .map(o => ({ opt: o, n: +o.value }))
            .filter(x => Number.isFinite(x.n) && x.n > 0 && x.n <= 500)
            .sort((a, b) => b.n - a.n);
          if (nums.length) pick = nums[0].opt;
        }
        if (!pick) return { ok: false, reason: 'no usable option', options: opts };
        sel.value = pick.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, picked: { text: pick.text, value: pick.value }, options: opts, currentRows: document.querySelectorAll('table tbody tr').length };
      });
      if (sizeResult.ok) {
        _step(`page-size set to "${sizeResult.picked.text}" (value=${sizeResult.picked.value}, ${sizeResult.options.length} options)`);
      } else {
        _step(`page-size NOT set: ${sizeResult.reason} ${sizeResult.options ? '— available: ' + JSON.stringify(sizeResult.options) : ''}`);
      }
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, input[type="submit"], a.btn'));
        const showBtn = btns.find(b => /show\s*report/i.test((b.innerText || b.value || '').trim()));
        if (showBtn) showBtn.click();
      });
    } catch (e) {
      console.warn('[ims-bot][scrape] page-prep failed:', e.message);
    }
    _cdrPageReady = true;
    _lastShowReportAt = Date.now();
    _step('first-visit prep done');
  } else {
    // Subsequent polls: enforce IMS's 15s minimum interval between Show Report
    // clicks. If we clicked <15s ago, skip the click entirely and just read
    // whatever data is currently rendered (it's still the freshest CDR data
    // we got — agents waiting for OTPs will be served from cache anyway).
    const sinceLast = Date.now() - _lastShowReportAt;
    if (sinceLast < 16000) {
      _step(`skip show-report click — only ${sinceLast}ms since last (IMS 15s rule)`);
      // No click, no wait — just fall through to extract current table rows
    } else {
      // Periodically (every 5 min) re-verify page size — IMS DataTables can
      // reset to default 25 on session refresh, silently capping our scrape.
      if (Date.now() - _lastPageSizeCheckAt > 5 * 60 * 1000) {
        try {
          const r = await page.evaluate(() => {
            const sel = document.querySelector('select[name$="_length"], select.dataTable-selector, .dataTables_length select');
            if (!sel) return { ok: false };
            const cur = +sel.value;
            // If currently small, bump back up
            if (cur > 0 && cur < 100) {
              const opts = Array.from(sel.options || []);
              const pick = opts.find(o => +o.value === 500)
                        || opts.find(o => +o.value === 250)
                        || opts.find(o => +o.value === 100);
              if (pick) {
                sel.value = pick.value;
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                return { ok: true, was: cur, now: pick.value, text: pick.text };
              }
            }
            return { ok: true, was: cur, unchanged: true };
          });
          _lastPageSizeCheckAt = Date.now();
          if (r && r.ok && !r.unchanged) {
            _step(`page-size re-bumped from ${r.was} → "${r.text}" (was reset by IMS)`);
          }
        } catch (_) { /* non-fatal */ }
      }
      try {
        // Race the click against a 20s hard timeout so a stuck CDP call doesn't
        // burn through the full protocolTimeout (180s) before we fall back.
        await Promise.race([
          page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, input[type="submit"], a.btn'));
            const showBtn = btns.find(b => /show\s*report/i.test((b.innerText || b.value || '').trim()));
            if (showBtn) showBtn.click();
          }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('show-report click timeout 20s')), 20000)),
        ]);
        _lastShowReportAt = Date.now();
        _step('show-report re-click done');
      } catch (e) {
        _step(`show-report click failed (${e.message}) — falling back to page reload`);
        try {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
          if (/\/login/i.test(page.url())) { loggedIn = false; _cdrPageReady = false; return []; }
          _lastShowReportAt = Date.now();
          _cdrPageReady = false; // force page-size re-init on next scrape
        } catch (_) { /* keep going — populated check will catch it */ }
      }
    }
  }

  _step('navigation/refresh done');
  // Wait for IMS DataTables AJAX to populate after Show Report click.
  // Heavy CDR responses can take 8-12s, so give 15s.
  const populated = await page.waitForFunction(
    () => {
      const rows = document.querySelectorAll('table tbody tr');
      if (!rows.length) return false;
      // Count how many rows look like real CDR data (have an 8-15 digit number)
      const dataRows = Array.from(rows).filter(r => {
        const t = (r.innerText || '').toLowerCase();
        if (/refresh must be done|attempt is logged/i.test(t)) return false;
        if (/^no data|^no record|^loading|^processing/i.test(t.trim())) return false;
        return /\d{8,15}/.test(t);
      });
      return dataRows.length > 0;
    },
    { timeout: 8000 }
  ).catch(() => null);
  _step(`table populated=${!!populated}`);

  // Debug snapshot — when populated check fails, dump page diagnostics so we
  // can see WHY (wrong selector? page in different state? login redirect?).
  if (!populated) {
    try {
      const diag = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        tables: document.querySelectorAll('table').length,
        rowsAnyTable: document.querySelectorAll('tr').length,
        rowsTbody: document.querySelectorAll('table tbody tr').length,
        firstRowText: (document.querySelector('table tbody tr')?.innerText || '').slice(0, 200),
        bodyTextSample: (document.body.innerText || '').slice(0, 300),
        hasLoadingClass: !!document.querySelector('.dataTables_processing[style*="block"], .loading'),
      }));
      console.log('[ims-bot][scrape][diag] not populated →', JSON.stringify(diag));
      logEvent('warn', `Scrape diag: tables=${diag.tables} tbody-rows=${diag.rowsTbody} url=${diag.url.slice(-40)}`);
    } catch (e) {
      console.warn('[ims-bot][scrape][diag] failed:', e.message);
    }
  }

  const out = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('table tbody tr').forEach((row) => {
      const cells = Array.from(row.querySelectorAll('td')).map(c => c.innerText.trim());
      if (cells.length < 5) return;

      // IMS CDR column order (live-verified):
      //   [0]=DATE  [1]=RANGE  [2]=NUMBER  [3]=CLI  [4]=SMS  [5]=CURRENCY  [6]=PAYOUT
      // We use POSITIONAL access for date/range/cli (more reliable than fuzzy
      // matching when the SMS body contains digits or matching patterns).

      // DATE: first cell matching YYYY-MM-DD HH:MM:SS pattern.
      // IMS displays times in the server's local timezone (BDT). Parse WITHOUT
      // appending 'Z' so JS uses local time — appending Z previously caused a
      // 6-hour shift that made the staleness guard reject every fresh OTP.
      const dateCell = cells[0] && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(cells[0])
        ? cells[0]
        : cells.find(t => /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(t));
      const dateTs = dateCell ? Math.floor(new Date(dateCell.replace(' ', 'T')).getTime() / 1000) : 0;

      // NUMBER: pure-digit cell of length 8-15 (after stripping spaces/dashes)
      const phone = cells.find(t => /^\+?\d{8,15}$/.test(t.replace(/[\s-]/g, '')));
      if (!phone) return;

      // RANGE: positional cell[1] (e.g. "Peru Bitel TF04")
      const range = cells[1] && cells[1] !== phone && cells[1] !== dateCell ? cells[1] : null;

      // CLI / Service: positional cell[3] (e.g. "Facebook", "WhatsApp", "Apple",
      // "Telegram", "Paypal"). Fallback: any short alphabetic cell that isn't
      // the range or SMS body.
      let cli = null;
      if (cells[3] && cells[3] !== phone && cells[3].length < 30 && /[A-Za-z]/.test(cells[3])) {
        cli = cells[3];
      }
      // Normalize common variants → canonical service name (case-insensitive)
      if (cli) {
        const c = cli.toLowerCase();
        if (/facebook|fb\b/.test(c)) cli = 'Facebook';
        else if (/whats\s*app|wa\b/.test(c)) cli = 'WhatsApp';
        else if (/telegram|tg\b/.test(c)) cli = 'Telegram';
        else if (/apple|imessage|ios/.test(c)) cli = 'Apple';
        else if (/paypal/.test(c)) cli = 'Paypal';
        else if (/google|gmail/.test(c)) cli = 'Google';
        else if (/instagram|insta|ig\b/.test(c)) cli = 'Instagram';
        else if (/tiktok/.test(c)) cli = 'TikTok';
        else if (/twitter|^x$/.test(c)) cli = 'Twitter';
        else if (/discord/.test(c)) cli = 'Discord';
        else if (/microsoft|outlook|hotmail/.test(c)) cli = 'Microsoft';
        // else keep original casing
      }

      // Language-agnostic OTP extraction (Arabic / Bengali / Cyrillic / CJK / etc all work).
      const otpDigits = new Set();
      let firstOtp = null;
      let sms = '';
      for (const c of cells) {
        if (c === phone || c === dateCell || c === range || c === cli) continue;
        if (c.length > sms.length && c.length < 500) sms = c;
        const re = /(?:^|[^\d])(\d{4,8})(?=[^\d]|$)/g;
        let mm;
        while ((mm = re.exec(c)) !== null) {
          const digits = mm[1];
          if (otpDigits.has(digits)) continue;
          otpDigits.add(digits);
          if (!firstOtp) firstOtp = digits;
        }
      }
      if (!firstOtp) return;
      out.push({
        phone_number: phone.replace(/[\s-]/g, ''),
        otp_code: firstOtp,
        sms_text: sms.slice(0, 200),
        range: range || null,
        cli: cli || null,
        date_ts: dateTs,
      });
    });
    return out;
  });
    if (out.length > _maxRowsSeen) _maxRowsSeen = out.length;
    const uniquePhones = new Set(out.map(r => r.phone_number)).size;
    _step(`done — extracted ${out.length} rows (${uniquePhones} unique phones, peak=${_maxRowsSeen})`);
    return out;
  })();
  try {
    return await _scrapeInFlight;
  } finally {
    _scrapeInFlight = null;
  }
}

// One full pass.
// IMPORTANT ordering: scrape OTPs FIRST so already-assigned numbers get their codes
// delivered ASAP (this is what agents care about most). New numbers come second.
async function tick() {
  // Stuck-detection: if a previous tick has been "busy" for >5 minutes, force-reset.
  // This used to deadlock the bot forever — heavy scrape would hang and every
  // subsequent tick logged "skipped — busy" indefinitely.
  if (busy) {
    const stuckSec = (Date.now() - tickStartedAt) / 1000;
    if (stuckSec > 300) {
      console.warn(`[ims-bot] tick was busy for ${Math.floor(stuckSec)}s — force-reset`);
      busy = false;
    } else {
      console.log(`[ims-bot] tick skipped — busy (${Math.floor(stuckSec)}s)`);
      return;
    }
  }
  busy = true;
  tickStartedAt = Date.now();
  console.log(`[ims-bot] tick start (loggedIn=${loggedIn})`);
  try {
    await ensureBrowser();
    if (!loggedIn) { console.log('[ims-bot] logging in…'); await login(); console.log('[ims-bot] login OK'); }

    // Heavy tick is now SESSION KEEPALIVE only — fast-poll (pollOtpsNow) owns
    // all OTP scraping. Calling deliverOtps() here would race with fast-poll
    // on the same browser page, triggering IMS's 15s rate-limit ("attempt is
    // logged" warning row → populated=false on next fast-poll).
    // Just verify session is alive — a no-op if loggedIn is true.
    const nums = []; // numbers scrape disabled
    emptyStreak = 0;

    consecFail = 0;
    status.consecFail = 0;
    status.lastScrapeAt = Math.floor(Date.now() / 1000);
    status.lastScrapeOk = true;
    status.totalScrapes++;

    // Low-pool alert — fire once per cooldown window when pool drops below threshold.
    try {
      const threshold = +(readSetting('ims_low_pool_threshold') || 100);
      const cooldownMin = +(readSetting('ims_low_pool_cooldown_min') || 60);
      const poolSize = db.prepare(
        "SELECT COUNT(*) c FROM allocations WHERE provider='ims' AND status='pool'"
      ).get().c;
      const now = Math.floor(Date.now() / 1000);
      if (
        threshold > 0 &&
        poolSize < threshold &&
        (now - lastLowPoolAlertAt) >= cooldownMin * 60
      ) {
        lastLowPoolAlertAt = now;
        const msg = `IMS pool is low: only ${poolSize} numbers left (threshold: ${threshold}). Consider scraping IMS or adding manually.`;
        logEvent('warn', `Low-pool alert: ${poolSize} < ${threshold}`);
        notifyAdmins('⚠️ IMS Pool Low', msg, 'warning');
      }
    } catch (_) { /* don't fail the tick on alert errors */ }
  } catch (e) {
    consecFail++;
    status.consecFail = consecFail;
    status.lastError = e.message;
    status.lastErrorAt = Math.floor(Date.now() / 1000);
    status.lastScrapeOk = false;
    console.error('[ims-bot] tick failed:', e.message);
    logEvent('error', 'Scrape failed: ' + e.message);
    if (consecFail >= 2) {
      console.warn('[ims-bot] recycling browser after repeated failures');
      logEvent('warn', 'Recycling browser after 2 consecutive failures');
      try { await browser?.close(); } catch (_) {}
      browser = null; page = null; loggedIn = false; _cdrPageReady = false;
      status.loggedIn = false;
      consecFail = 0;
    }
  } finally {
    busy = false;
  }
}

// Cache of last scraped OTPs — used by getRecentOtpFor() so the IMS provider
// can detect "this number was already used recently" before assigning to an agent,
// AND used by deliverOtps() to backfill OTPs that arrived before/just-after allocation.
//
// BURST-SAFE: stores up to 5 OTPs per phone (newest first). Critical for the
// scenario where a single phone receives multiple OTPs in rapid succession
// (e.g. resends, multiple service signups). Old single-entry cache would
// overwrite earlier OTPs and lose them.
//
// Map: phone_number → Array<{ otp_code, date_ts, sms_text, cli, cachedAt }>
const recentOtpCache = new Map();
const RECENT_OTP_TTL = 30 * 60; // 30 minutes
const MAX_OTPS_PER_PHONE = 5;

function _pruneOldEntries(arr) {
  const now = Math.floor(Date.now() / 1000);
  return arr.filter(e => now - e.cachedAt <= RECENT_OTP_TTL);
}

// Returns the LATEST cached OTP for this phone (used by IMS provider to
// detect "already used" numbers before assigning).
function getRecentOtpFor(phone) {
  const arr = recentOtpCache.get(phone);
  if (!arr || !arr.length) return null;
  const fresh = _pruneOldEntries(arr);
  if (!fresh.length) { recentOtpCache.delete(phone); return null; }
  if (fresh.length !== arr.length) recentOtpCache.set(phone, fresh);
  return fresh[0]; // newest first
}

// Add (or refresh) an OTP entry for a phone. Newest goes to front. Dedupe by
// (otp_code, date_ts) so re-scrapes don't grow the array unnecessarily.
function _addToCache(phone, entry) {
  const existing = recentOtpCache.get(phone) || [];
  // Dedupe: same OTP code with same/very-close timestamp = same SMS, skip.
  const dup = existing.find(e =>
    e.otp_code === entry.otp_code &&
    Math.abs((e.date_ts || 0) - (entry.date_ts || 0)) < 5
  );
  if (dup) {
    // Just refresh cachedAt so TTL eviction doesn't drop it
    dup.cachedAt = entry.cachedAt;
    return;
  }
  existing.unshift(entry);
  // Keep only the newest MAX_OTPS_PER_PHONE entries
  if (existing.length > MAX_OTPS_PER_PHONE) existing.length = MAX_OTPS_PER_PHONE;
  recentOtpCache.set(phone, existing);
}

// Pick the best OTP to deliver for a given allocation. Strategy:
//   1) Prefer OTPs that arrived AFTER allocated_at (these are definitely for this agent)
//      — among those, pick the EARLIEST (first SMS post-allocation = the one they're waiting for).
//   2) Otherwise fall back to the newest cached OTP (covers pre-existing OTP backfill case).
function _pickBestOtpFor(allocation) {
  const arr = recentOtpCache.get(allocation.phone_number);
  if (!arr || !arr.length) return null;
  const fresh = _pruneOldEntries(arr);
  if (!fresh.length) return null;
  const allocAt = +allocation.allocated_at || 0;
  // Candidates that arrived after allocation (with 10s grace for clock skew)
  const postAlloc = fresh
    .filter(e => e.date_ts && e.date_ts >= (allocAt - 10))
    .sort((a, b) => a.date_ts - b.date_ts); // earliest first
  if (postAlloc.length) return postAlloc[0];
  return fresh[0]; // newest pre-existing
}

// Helper: pull OTPs once and credit any matching active allocations.
// Used by tick() AND by the lightweight `pollOtpsNow()` fast-poll loop.
async function deliverOtps() {
  const otpsRaw = await scrapeOtps().catch((e) => { dwarn('[ims-bot] scrapeOtps:', e.message); return []; });
  const nowSec = Math.floor(Date.now() / 1000);
  // Debug: list scraped phones + how many active allocations are awaiting OTP
  let pendingCount = 0;
  try {
    const phones = otpsRaw.slice(0, 5).map(o => `${o.phone_number}=${o.otp_code}`).join(',');
    pendingCount = db.prepare("SELECT COUNT(*) c FROM allocations WHERE provider='ims' AND status='active' AND otp IS NULL").get().c;
    console.log(`[ims-bot][deliver] scraped=${otpsRaw.length} top5=[${phones}] pendingAlloc=${pendingCount}`);
  } catch (_) {}
  status.pendingAlloc = pendingCount;

  // (a) Refresh cache. otpsRaw is newest-first per scrapeOtps(); add ALL entries
  // (not just first per phone) so multi-OTP bursts on the same phone are preserved.
  for (const o of otpsRaw) {
    _addToCache(o.phone_number, {
      otp_code: o.otp_code,
      date_ts: o.date_ts || nowSec,
      sms_text: o.sms_text,
      cli: o.cli || null,
      cachedAt: nowSec,
    });
  }
  // (b) Backfill: walk EVERY active IMS allocation that still has otp=NULL
  // and try to match using best-fit selection (prefers post-allocation OTPs).
  let delivered = 0;
  let pending = [];
  try {
    pending = db.prepare(`
      SELECT * FROM allocations
      WHERE provider='ims' AND status='active' AND otp IS NULL
      ORDER BY allocated_at DESC
    `).all();
  } catch (_) { pending = []; }
  for (const a of pending) {
    const cached = _pickBestOtpFor(a);
    if (!cached) continue;
    const allocAt = +a.allocated_at || 0;
    // Stale-OTP guard: if the picked OTP arrived BEFORE allocation, only deliver
    // if this exact (number, otp) wasn't already delivered to someone else.
    if (cached.date_ts && allocAt && cached.date_ts < (allocAt - 60)) {
      const dup = db.prepare(`
        SELECT 1 FROM allocations
        WHERE provider='ims' AND phone_number=? AND otp=? AND id<>?
        LIMIT 1
      `).get(a.phone_number, cached.otp_code, a.id);
      if (dup) continue; // truly stale — already delivered before
      console.log(`[ims-bot] delivering pre-existing OTP for ${a.phone_number} (otp_ts=${cached.date_ts}, alloc_ts=${allocAt})`);
    }
    try {
      await markOtpReceived(a, cached.otp_code, cached.cli || null);
      status.otpsDeliveredTotal++;
      delivered++;
      console.log(`[ims-bot] OTP delivered: ${a.phone_number} → ${cached.otp_code} (alloc#${a.id})`);
      logEvent('success', `OTP delivered to ${a.phone_number}`, { otp: cached.otp_code, alloc: a.id });
    } catch (e) {
      dwarn(`[ims-bot] markOtpReceived failed for ${a.phone_number}:`, e.message);
    }
  }
  return delivered;
}

// Helper: ensure system pool-owner user exists
function ensurePoolUser() {
  let u = db.prepare("SELECT id FROM users WHERE username = '__ims_pool__'").get();
  if (!u) {
    const r = db.prepare(`INSERT INTO users (username, password_hash, role, status) VALUES ('__ims_pool__', '!', 'agent', 'suspended')`).run();
    u = { id: r.lastInsertRowid };
  }
  return u;
}

// Notify all admins (broadcast-style — one row per admin user)
function notifyAdmins(title, message, type = 'warning') {
  try {
    const admins = db.prepare("SELECT id FROM users WHERE role='admin'").all();
    const ins = db.prepare("INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)");
    for (const a of admins) ins.run(a.id, title, message, type);
  } catch (e) {
    dwarn('[ims-bot] notifyAdmins failed:', e.message);
  }
}

function start() {
  // Re-read credentials from DB (admin may have updated via UI)
  ({ ENABLED, BASE_URL, USERNAME, PASSWORD } = resolveCreds());
  status.enabled = ENABLED;
  status.baseUrl = BASE_URL;
  status.intervalSec = INTERVAL;
  if (!ENABLED) {
    console.log('✗ IMS bot disabled (enable from admin panel or set IMS_ENABLED=true)');
    logEvent('warn', 'Start skipped — bot disabled');
    return;
  }
  if (!USERNAME || !PASSWORD) {
    console.warn('✗ IMS bot: credentials not set');
    status.lastError = 'IMS credentials not set — open admin panel → IMS Status to add';
    logEvent('error', 'Credentials missing');
    return;
  }
  if (scrapeTimer) { clearInterval(scrapeTimer); scrapeTimer = null; }
  if (otpTimer) { clearInterval(otpTimer); otpTimer = null; }
  // Recovery: any 'claiming' rows from a crashed/restarted bulk allocation
  // should be returned to 'pool' so they can be assigned again. Safe because
  // legitimate claims flip to 'active' inside the same transaction in routes/numbers.js.
  try {
    const r = db.prepare("UPDATE allocations SET status='pool' WHERE provider='ims' AND status='claiming'").run();
    if (r.changes) console.log(`[ims-bot] recovered ${r.changes} 'claiming' allocations → 'pool'`);
  } catch (_) {}
  status.running = true;
  emptyStreak = 0;
  console.log(`✓ IMS bot starting (heavy tick every ${INTERVAL}s for keepalive, headless=${HEADLESS}, base=${BASE_URL})`);
  // First tick: just login + go to CDR page (no scraping). Fast-poll handles all OTP work.
  setTimeout(async () => {
    try {
      await ensureBrowser();
      if (!loggedIn) await login();
      console.log('[ims-bot] initial login complete — fast-poll will handle OTP scraping');
    } catch (e) {
      console.error('[ims-bot] initial login failed:', e.message);
      logEvent('error', 'Initial login failed: ' + e.message);
    }
  }, 3000);
  // Heavy tick is now a SESSION KEEPALIVE only — no scraping (fast-poll does that).
  // It just verifies loggedIn status and re-logs in if needed. Lightweight.
  scrapeTimer = setInterval(async () => {
    if (busy || otpBusy) return;
    if (!loggedIn) {
      busy = true; tickStartedAt = Date.now();
      try { await login(); _cdrPageReady = false; }
      catch (e) { console.warn('[ims-bot] keepalive re-login failed:', e.message); }
      finally { busy = false; }
    }
  }, INTERVAL * 1000);

  // FAST OTP loop — adaptive interval based on burst load.
  //   • idle (0 pending allocations)        → IDLE_INTERVAL    (gentler on IMS)
  //   • light (1-9 pending)                  → BASE_INTERVAL    (admin-tuned default)
  //   • burst (10+ pending, "100-300 OTP")   → BURST_INTERVAL   (IMS minimum + 3s safety)
  //
  // IMS enforces "minimum 15s between CDR refreshes" — going below triggers a
  // warning page instead of data and risks an account ban. Hard floor: 18s.
  const dbOtpInt = +(readSetting('ims_otp_interval') || 0);
  const envOtpInt = +(process.env.IMS_OTP_INTERVAL || 20);
  let BASE_INTERVAL = dbOtpInt > 0 ? dbOtpInt : envOtpInt;
  if (BASE_INTERVAL < 18) BASE_INTERVAL = 18;
  if (BASE_INTERVAL > 120) BASE_INTERVAL = 120;
  const BURST_INTERVAL = 18;                          // IMS floor + 3s safety
  const IDLE_INTERVAL = Math.max(BASE_INTERVAL, 30);  // slow down when nothing's pending
  status.otpIntervalSec = BASE_INTERVAL;
  status.otpIntervalBurstSec = BURST_INTERVAL;
  status.otpIntervalIdleSec = IDLE_INTERVAL;
  console.log(`✓ IMS fast-OTP poll: base=${BASE_INTERVAL}s, burst=${BURST_INTERVAL}s, idle=${IDLE_INTERVAL}s (adaptive)`);

  // Adaptive scheduler — recomputes next delay after each tick based on burst state.
  _scheduledStop = false;
  function _scheduleNextPoll() {
    if (_scheduledStop) return;
    let nextDelay = BASE_INTERVAL;
    let mode = 'base';
    try {
      const pending = db.prepare("SELECT COUNT(*) c FROM allocations WHERE provider='ims' AND status='active' AND otp IS NULL").get().c;
      status.pendingAlloc = pending;
      if (pending === 0) { nextDelay = IDLE_INTERVAL; mode = 'idle'; }
      else if (pending >= 10) { nextDelay = BURST_INTERVAL; mode = 'burst'; }
      else { nextDelay = BASE_INTERVAL; mode = 'base'; }
      status.otpScheduleMode = mode;
      status.otpNextPollIn = nextDelay;
    } catch (_) { /* fall through with base */ }
    otpTimer = setTimeout(async () => {
      try { await pollOtpsNow(); } finally { _scheduleNextPoll(); }
    }, nextDelay * 1000);
  }
  _scheduleNextPoll();
}

// Lightweight OTP-only poll — runs frequently between heavy ticks.
// Skips entirely if a heavy tick is in progress (which already delivers OTPs).
let _pollSkipLogCount = 0;
let _otpBusyStartedAt = 0;
let _consecFastFails = 0;
let _lastLoginAlertAt = 0;
async function pollOtpsNow() {
  // Stuck-detection for fast-poll itself (rare, but defensive)
  if (otpBusy) {
    if ((Date.now() - _otpBusyStartedAt) / 1000 > 120) {
      console.warn('[ims-bot] otpBusy stuck >120s — force-reset');
      otpBusy = false;
    } else {
      return;
    }
  }
  // Don't fight the heavy tick over the shared page — but don't silently die either.
  if (busy) {
    if ((_pollSkipLogCount++ % 6) === 0) {
      console.log(`[ims-bot] fast-poll waiting — heavy tick in progress (${Math.floor((Date.now() - tickStartedAt) / 1000)}s)`);
    }
    return;
  }
  // Auto re-login if session dropped — don't sit idle waiting for heavy tick.
  if (!loggedIn && page) {
    otpBusy = true;
    _otpBusyStartedAt = Date.now();
    try {
      console.log('[ims-bot] fast-poll: session expired — re-logging in');
      await login();
      _cdrPageReady = false;
      _consecFastFails = 0;
      logEvent('success', 'Auto re-login OK after session drop');
    } catch (e) {
      console.warn('[ims-bot] fast-poll re-login failed:', e.message);
      logEvent('error', 'Auto re-login failed: ' + e.message);
      // Notify admins once per hour about persistent login failures
      const now = Math.floor(Date.now() / 1000);
      if (now - _lastLoginAlertAt > 3600) {
        _lastLoginAlertAt = now;
        notifyAdmins('🔐 IMS Login Failing', `Bot cannot log in: ${e.message}. OTP delivery is paused. Check IMS credentials in admin panel.`, 'error');
      }
    } finally { otpBusy = false; }
    return;
  }
  if (!page) {
    if ((_pollSkipLogCount++ % 6) === 0) {
      console.log(`[ims-bot] fast-poll skipped — page not ready`);
    }
    return;
  }
  otpBusy = true;
  _otpBusyStartedAt = Date.now();
  const _pollT0 = Date.now();
  try {
    // 120s wrapper — IMS slow-day reality: page-size bump + AJAX show-report
    // + 500-row populated wait can legitimately reach 60-90s. 120s gives
    // headroom without masking truly-stuck cases (browser recycle at 5 fails).
    const delivered = await Promise.race([
      deliverOtps(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('fast-poll timeout 120s')), 120000)),
    ]);
    const elapsed = Date.now() - _pollT0;
    status.lastScrapeAt = Math.floor(Date.now() / 1000);
    status.lastScrapeOk = true;
    _consecFastFails = 0;
    if (typeof delivered === 'number' && delivered > 0) {
      console.log(`[ims-bot] fast-poll delivered ${delivered} OTP(s) in ${elapsed}ms`);
    } else if (elapsed > 8000) {
      // Slow but successful — useful diagnostic for "why is OTP late"
      console.log(`[ims-bot] fast-poll slow scrape: ${elapsed}ms (no new OTPs)`);
    }
  } catch (e) {
    const elapsed = Date.now() - _pollT0;
    _consecFastFails++;
    // Don't flip lastScrapeOk to false on a single fast-poll timeout — heavy tick owns that flag.
    // Just record the error so admin can see it in the panel.
    status.lastError = `fast-poll: ${e.message} (after ${elapsed}ms, fail#${_consecFastFails})`;
    status.lastErrorAt = Math.floor(Date.now() / 1000);
    console.warn(`[ims-bot] otp-poll failed after ${elapsed}ms (consec=${_consecFastFails}):`, e.message);
    logEvent('warn', `Fast-poll failed (#${_consecFastFails}): ${e.message}`);

    // After 5 consecutive fast-poll failures, recycle the browser — likely a
    // hung puppeteer page or stale session that won't recover on its own.
    if (_consecFastFails >= 5) {
      console.warn('[ims-bot] 5 consecutive fast-poll fails — recycling browser');
      logEvent('warn', 'Recycling browser after 5 fast-poll failures');
      try { await browser?.close(); } catch (_) {}
      browser = null; page = null; loggedIn = false; _cdrPageReady = false;
      status.loggedIn = false;
      _consecFastFails = 0;
    }
  } finally {
    otpBusy = false;
  }
}

async function stop() {
  _scheduledStop = true; // halt the adaptive setTimeout chain
  if (scrapeTimer) { clearInterval(scrapeTimer); scrapeTimer = null; }
  if (otpTimer) { clearTimeout(otpTimer); otpTimer = null; } // setTimeout now, not setInterval
  try { await browser?.close(); } catch (_) {}
  browser = null; page = null; loggedIn = false; _cdrPageReady = false;
  status.running = false;
  status.loggedIn = false;
}

// CLI helpers (run with: node workers/imsBot.js --inspect | --dump-numbers)
if (require.main === module && (process.argv.includes('--inspect') || process.argv.includes('--dump-numbers'))) {
  require('dotenv').config();
  const dumpMode = process.argv.includes('--dump-numbers');
  (async () => {
    process.env.IMS_HEADLESS = dumpMode ? 'true' : 'false';
    await ensureBrowser();
    try {
      await login();
      console.log('[dump] login OK, url=', page.url());
    } catch (e) {
      console.warn('login failed:', e.message);
    }

    if (dumpMode) {
      // Try common IMS paths and dump whichever loads
      const paths = ['/client/MySMSNumbers', '/client/SMSNumbers', '/client/Numbers', '/client/MyNumbers', '/client/SMSNumberList', '/client/SMSCDRStats'];
      for (const p of paths) {
        try {
          const url = `${BASE_URL}${p}`;
          await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
          const finalUrl = page.url();
          const html = await page.content();
          const fname = `ims-dump${p.replace(/\//g, '_')}.html`;
          fs.writeFileSync(fname, html);
          console.log(`[dump] ${p} → ${finalUrl} (${html.length} bytes) → ${fname}`);
          // Also extract a quick summary: tables/rows/links/menu items
          const summary = await page.evaluate(() => {
            const tables = document.querySelectorAll('table').length;
            const rows = document.querySelectorAll('table tbody tr').length;
            const links = Array.from(document.querySelectorAll('a[href]'))
              .map(a => `${a.innerText.trim().slice(0,40)} → ${a.getAttribute('href')}`)
              .filter(t => t.length > 5).slice(0, 40);
            return { tables, rows, links };
          });
          console.log(`   tables=${summary.tables} rows=${summary.rows}`);
          console.log(`   links sample:\n     ${summary.links.join('\n     ')}`);
        } catch (e) {
          console.warn(`[dump] ${p} failed:`, e.message);
        }
      }
      await stop();
      process.exit(0);
    }

    console.log('Inspector ready. URL:', page.url(), '— navigate around, Ctrl+C to dump.');
    process.on('SIGINT', async () => {
      try {
        const html = await page.content();
        fs.writeFileSync('ims-page.html', html);
        console.log('saved ims-page.html');
      } catch (_) {}
      await stop();
      process.exit(0);
    });
  })();
}

// Manual one-off scrape — runs a single tick on demand (admin "Scrape Now" button).
// Returns a small summary so the UI can show "X numbers added, Y OTPs delivered".
async function scrapeNow() {
  if (!status.running) {
    return { ok: false, error: 'Bot is not running — start it first' };
  }
  if (busy) return { ok: false, error: 'A scrape is already in progress' };
  const before = { added: status.numbersAddedTotal, otps: status.otpsDeliveredTotal };
  logEvent('info', 'Manual scrape triggered by admin');
  await tick();
  return {
    ok: true,
    added: status.numbersAddedTotal - before.added,
    otps: status.otpsDeliveredTotal - before.otps,
  };
}

// =============================================================
// Live-sync: scrape IMS once and reconcile our pool with reality.
//   • Adds any new numbers IMS now has (same as a normal scrape)
//   • Deletes pool numbers that are NO LONGER in IMS (sold/expired upstream)
//   • Active/received/expired allocations are NEVER touched (agent owns them)
// Returns: { ok, added, removed, kept, scraped, ranges }
// =============================================================
async function syncLive() {
  if (!status.running) return { ok: false, error: 'Bot is not running — start it first' };
  if (busy) return { ok: false, error: 'A scrape is already in progress' };

  busy = true;
  try {
    await ensureBrowser();
    if (!loggedIn) await login();

    logEvent('info', 'Live-sync triggered by admin');
    const nums = await scrapeNumbers();
    if (!nums.length) {
      return { ok: false, error: 'No numbers returned from IMS — login or page issue?' };
    }

    const live = new Set(nums.map(n => n.phone_number));
    const sysUser = ensurePoolUser();

    // Track ranges (operators) that appeared in this scrape
    const liveRanges = new Set(nums.map(n => n.operator).filter(Boolean));

    let added = 0, removed = 0, kept = 0;
    const exists = db.prepare("SELECT 1 FROM allocations WHERE provider='ims' AND phone_number=? LIMIT 1");
    const ins = db.prepare(`
      INSERT INTO allocations (user_id, provider, phone_number, country_code, operator, status, allocated_at)
      VALUES (?, 'ims', ?, ?, ?, 'pool', strftime('%s','now'))
    `);
    // Pool snapshot: only POOL rows are eligible for deletion. Active/received/expired untouched.
    const poolRows = db.prepare(
      "SELECT id, phone_number FROM allocations WHERE provider='ims' AND status='pool'"
    ).all();
    const del = db.prepare("DELETE FROM allocations WHERE id = ?");

    const tx = db.transaction(() => {
      // Add: numbers in IMS but not in DB at all
      for (const n of nums) {
        if (exists.get(n.phone_number)) { kept++; continue; }
        ins.run(sysUser.id, n.phone_number, null, n.operator || null);
        added++;
      }
      // Remove: pool numbers that IMS no longer has
      for (const r of poolRows) {
        if (!live.has(r.phone_number)) {
          del.run(r.id);
          removed++;
        }
      }
    });
    tx();

    status.numbersScrapedTotal += nums.length;
    status.numbersAddedTotal += added;
    status.lastScrapeAt = Math.floor(Date.now() / 1000);
    status.lastScrapeOk = true;

    const summary = `Live-sync: +${added} added · -${removed} removed · ${kept} kept · ${nums.length} live in IMS`;
    console.log(`[ims-bot] ${summary}`);
    logEvent('success', summary, { ranges: [...liveRanges] });

    return {
      ok: true,
      added, removed, kept,
      scraped: nums.length,
      ranges: [...liveRanges],
    };
  } catch (e) {
    status.lastError = e.message;
    status.lastErrorAt = Math.floor(Date.now() / 1000);
    logEvent('error', 'Live-sync failed: ' + e.message);
    return { ok: false, error: e.message };
  } finally {
    busy = false;
  }
}

// =============================================================
// BACKGROUND Numbers Scrape — fire-and-forget version of syncLive.
// Returns immediately with { jobId, status: 'running' }, runs scrape in background.
// Frontend polls getNumbersJobStatus() every 2-3s to track progress.
// =============================================================
let _numbersJob = {
  id: 0,
  status: 'idle',     // 'idle' | 'running' | 'done' | 'failed'
  startedAt: null,    // unix sec
  finishedAt: null,
  result: null,       // { added, removed, kept, scraped, ranges }
  error: null,
  progress: '',       // human-readable: "scraping page 5/12..."
};

function getNumbersJobStatus() {
  return { ..._numbersJob };
}

function startNumbersScrapeBackground() {
  if (_numbersJob.status === 'running') {
    return { ok: false, error: 'A numbers scrape is already running', jobId: _numbersJob.id };
  }
  if (busy) {
    return { ok: false, error: 'Bot is busy with another task — wait a moment' };
  }
  if (!status.running) {
    return { ok: false, error: 'Bot is not running — start it first' };
  }
  _numbersJob = {
    id: Date.now(),
    status: 'running',
    startedAt: Math.floor(Date.now() / 1000),
    finishedAt: null,
    result: null,
    error: null,
    progress: 'Starting…',
  };
  logEvent('info', 'Background numbers scrape triggered by admin');

  // Run in background — don't await
  (async () => {
    try {
      _numbersJob.progress = 'Calling syncLive (browser scrape + reconcile)…';
      const result = await syncLive();
      _numbersJob.status = result.ok ? 'done' : 'failed';
      _numbersJob.result = result.ok ? {
        added: result.added, removed: result.removed,
        kept: result.kept, scraped: result.scraped, ranges: result.ranges,
      } : null;
      _numbersJob.error = result.ok ? null : (result.error || 'Unknown error');
      _numbersJob.finishedAt = Math.floor(Date.now() / 1000);
      _numbersJob.progress = result.ok
        ? `Done: +${result.added} added, -${result.removed} removed, ${result.kept} kept`
        : `Failed: ${result.error}`;
    } catch (e) {
      _numbersJob.status = 'failed';
      _numbersJob.error = e.message;
      _numbersJob.finishedAt = Math.floor(Date.now() / 1000);
      _numbersJob.progress = `Crashed: ${e.message}`;
      logEvent('error', 'Background numbers scrape crashed: ' + e.message);
    }
  })();

  return { ok: true, jobId: _numbersJob.id, status: 'running' };
}

module.exports = {
  start, stop, restart, tick, scrapeNow, syncLive, solveCaptchaText,
  getStatus, logEvent, getRecentOtpFor,
  startNumbersScrapeBackground, getNumbersJobStatus,
};

