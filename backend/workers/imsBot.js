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
let otpTimer = null;        // fast OTP-only poll loop
const EMPTY_LIMIT = +(process.env.IMS_EMPTY_LIMIT || 10);
let lastLowPoolAlertAt = 0;   // unix seconds — debounce low-pool notifications

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
    const activeAssigned = db.prepare("SELECT COUNT(*) c FROM allocations WHERE provider='ims' AND status='active'").get().c;
    const otpReceived = db.prepare("SELECT COUNT(*) c FROM allocations WHERE provider='ims' AND status='received'").get().c;
    return { ...status, poolSize, activeAssigned, otpReceived, emptyStreak, emptyLimit: EMPTY_LIMIT, events: events.slice() };
  } catch (_) {
    return { ...status, poolSize: 0, activeAssigned: 0, otpReceived: 0, emptyStreak, emptyLimit: EMPTY_LIMIT, events: events.slice() };
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
// Reads the captcha label, evaluates basic arithmetic, returns the answer string.
// Handles: "5 + 3 = ?", "12-4=?", "7 × 2 = ?", "8 / 2 = ?", "What is 5+3"
function solveCaptchaText(text) {
  if (!text) return null;
  // Normalize unicode operators
  const cleaned = text
    .replace(/[×x✕]/gi, '*')
    .replace(/[÷]/g, '/')
    .replace(/[−–—]/g, '-')
    .replace(/=\s*\?/g, '')
    .replace(/[^\d+\-*/(). ]/g, ' ');
  // Find the arithmetic expression: e.g. "5 + 3"
  const m = cleaned.match(/(-?\d+(?:\.\d+)?)\s*([+\-*/])\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const a = parseFloat(m[1]); const op = m[2]; const b = parseFloat(m[3]);
  let r;
  switch (op) {
    case '+': r = a + b; break;
    case '-': r = a - b; break;
    case '*': r = a * b; break;
    case '/': r = b === 0 ? null : a / b; break;
  }
  return r == null ? null : String(Number.isInteger(r) ? r : r.toFixed(2));
}

async function login() {
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

  // Find captcha question (e.g. "What is 6 + 5 = ? :" with input next to it)
  const { captchaText, captchaSel } = await page.evaluate(() => {
    // 1) Find the math expression anywhere on the page
    const allText = document.body.innerText || '';
    const mathMatch = allText.match(/(?:what\s+is\s+)?(-?\d+)\s*([+\-x×*/÷])\s*(-?\d+)\s*=\s*\?/i);
    if (!mathMatch) return { captchaText: null, captchaSel: null };
    const expr = mathMatch[0];

    // 2) Locate the DOM node containing that text
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node, host = null;
    while ((node = walker.nextNode())) {
      if (/(-?\d+)\s*[+\-x×*/÷]\s*(-?\d+)\s*=\s*\?/i.test(node.nodeValue || '')) {
        host = node.parentElement; break;
      }
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
      const btn = document.querySelector('button[type="submit"], input[type="submit"]') ||
                  Array.from(document.querySelectorAll('button')).find(b => /login|sign in/i.test(b.innerText));
      if (btn) btn.click();
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
    // Common cause: wrong captcha. Throw so caller retries.
    throw new Error('IMS login failed (likely captcha) — will retry');
  }
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
async function scrapeOtps() {
  // Use 'domcontentloaded' — IMS pages do constant AJAX polling so networkidle never fires.
  // If goto fails outright, throw so caller recycles the page (don't silently scrape stale DOM).
  try {
    await page.goto(`${BASE_URL}/client/SMSCDRStats`, { waitUntil: 'domcontentloaded', timeout: 12000 });
  } catch (e) {
    throw new Error('CDR page navigation failed: ' + e.message);
  }
  if (/\/login/i.test(page.url())) { loggedIn = false; return []; }

  // CRITICAL: IMS SMSCDRStats renders an EMPTY table by default — must click "Show Report".
  // Wait for any button/form to mount first.
  try { await page.waitForSelector('button, input[type=submit], form', { timeout: 4000 }); } catch (_) {}

  let clicked = null;
  try {
    clicked = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('button, input[type=submit], input[type=button], a, [role=button]'));
      const target = all.find(b => /show\s*report|search|filter|submit|refresh/i.test((b.innerText || b.value || b.title || '').trim()));
      if (target) { target.click(); return (target.innerText || target.value || '').trim() || 'clicked'; }
      const form = document.querySelector('form');
      if (form) { form.submit(); return 'form-submit'; }
      return null;
    });
  } catch (_) {}

  // Short fixed wait for AJAX to fire (IMS DataTables ~600ms response).
  await new Promise(r => setTimeout(r, 1000));

  // Then poll briefly for actual data rows. Hard cap 5s (was 8s) to keep total under 20s.
  await page.waitForFunction(
    () => {
      const rows = document.querySelectorAll('table tbody tr');
      if (!rows.length) return false;
      const first = (rows[0].innerText || '').toLowerCase();
      if (rows.length === 1 && /no data|empty|no record/i.test(first)) return false;
      return Array.from(rows).some(r => /\d{8,15}/.test(r.innerText || ''));
    },
    { timeout: 5000 }
  ).catch(() => null);

  if (!clicked) dwarn('[ims-bot] Show Report button not found on CDR page');

  return await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('table tbody tr').forEach((row) => {
      const cells = Array.from(row.querySelectorAll('td')).map(c => c.innerText.trim());
      if (cells.length < 5) return;

      // DATE: first cell matching YYYY-MM-DD HH:MM:SS pattern.
      // IMS displays times in the server's local timezone (BDT). Parse WITHOUT
      // appending 'Z' so JS uses local time — appending Z previously caused a
      // 6-hour shift that made the staleness guard reject every fresh OTP.
      const dateCell = cells.find(t => /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(t));
      const dateTs = dateCell ? Math.floor(new Date(dateCell.replace(' ', 'T')).getTime() / 1000) : 0;

      // NUMBER: pure-digit cell of length 8-15 (after stripping spaces/dashes)
      const phone = cells.find(t => /^\+?\d{8,15}$/.test(t.replace(/[\s-]/g, '')));
      if (!phone) return;

      // RANGE: a short alphabetic cell that's not the SMS body (e.g. "Peru Bitel TF04")
      const range = cells.find(t => /[A-Za-z]/.test(t) && t.length < 40 && t !== phone && !/^\d{4}-\d{2}-\d{2}/.test(t));

      // Language-agnostic OTP extraction (Arabic / Bengali / Cyrillic / CJK / etc all work):
      //   • Scan ALL cells (skip date/phone/range key cells).
      //   • Collect every STANDALONE 4-8 digit run.
      //   • Embedded digits in tokens like "H29QFsn4Sr" are skipped automatically
      //     (the boundary requires non-digit before/after).
      //   • If the SAME OTP appears twice in the SMS (e.g. "#58374764 ... 58374764"),
      //     dedupe and keep ONE.
      //   • Pick the FIRST unique 4-8 digit number — this is the OTP.
      const otpDigits = new Set();
      let firstOtp = null;
      let sms = '';
      for (const c of cells) {
        if (c === phone || c === dateCell || c === range) continue;
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
        date_ts: dateTs,
      });
    });
    return out;
  });
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

    // 1) OTPs only — agents care about OTP delivery, not refilling pool every cycle.
    // Number-list scraping is DISABLED in the heavy tick because:
    //   • IMS My-SMS-Numbers page has 17k+ rows → pagination takes 90-180s
    //   • That hangs the tick longer than INTERVAL → "skipped — busy" deadlock
    //   • Pool is refilled via admin "Manual Paste" or the explicit "Sync Live" button
    // Hard 30s cap on the OTP scrape — if puppeteer hangs (CDR page stalls, AJAX
    // never settles, etc.) we abort and let the next tick try fresh. Without this
    // a single hung evaluate() blocks every subsequent tick forever.
    await Promise.race([
      deliverOtps(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('deliverOtps timeout 20s')), 20000)),
    ]);
    const nums = []; // numbers scrape disabled — see above. Set empty so auto-pause logic works.
    // Auto-pause disabled — numbers scrape removed, so empty-streak no longer applies.
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
    if (consecFail >= 3) {
      console.warn('[ims-bot] recycling browser after repeated failures');
      logEvent('warn', 'Recycling browser after 3 consecutive failures');
      try { await browser?.close(); } catch (_) {}
      browser = null; page = null; loggedIn = false;
      status.loggedIn = false;
      consecFail = 0;
    }
  } finally {
    busy = false;
  }
}

// Helper: pull OTPs once and credit any matching active allocations.
// Used by tick() AND by the lightweight `pollOtpsNow()` fast-poll loop.
async function deliverOtps() {
  const otpsRaw = await scrapeOtps().catch((e) => { dwarn('[ims-bot] scrapeOtps:', e.message); return []; });
  if (!otpsRaw.length) return 0;
  const seenPhones = new Set();
  const otps = [];
  for (const o of otpsRaw) {
    if (seenPhones.has(o.phone_number)) continue;
    seenPhones.add(o.phone_number);
    otps.push(o);
  }
  let delivered = 0;
  for (const o of otps) {
    // Match the most recent ACTIVE allocation for this phone.
    // No date/timestamp filtering — as long as the agent's allocation is still
    // 'active' (i.e. within the 8-min expiry window enforced by otpPoller's
    // cleanup cron), ANY OTP that IMS shows for this number must be credited.
    // Stale-allocation protection comes from status='active' alone:
    // expired allocations are flipped to 'expired' and won't match here.
    const a = db.prepare(`
      SELECT * FROM allocations
      WHERE provider='ims' AND phone_number=? AND status='active' AND otp IS NULL
      ORDER BY allocated_at DESC LIMIT 1
    `).get(o.phone_number);
    if (a) {
      await markOtpReceived(a, o.otp_code);
      status.otpsDeliveredTotal++;
      delivered++;
      console.log(`[ims-bot] OTP delivered: ${o.phone_number} → ${o.otp_code} (alloc#${a.id})`);
      logEvent('success', `OTP delivered to ${o.phone_number}`, { otp: o.otp_code, alloc: a.id });
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
  status.running = true;
  emptyStreak = 0;
  console.log(`✓ IMS bot starting (every ${INTERVAL}s, headless=${HEADLESS}, base=${BASE_URL})`);
  setTimeout(tick, 5000);
  scrapeTimer = setInterval(tick, INTERVAL * 1000);

  // FAST OTP loop — every OTP_INTERVAL seconds (default 10s) we ONLY scrape the
  // OTP/CDR page (no number list, no pagination). This is what makes assigned
  // numbers receive their OTP within ~10s of arrival, even though the heavy
  // number-list scrape only runs every 60s.
  // Priority: DB setting (admin-tunable) > env var > default 10s. Clamp 3-120s.
  const dbOtpInt = +(readSetting('ims_otp_interval') || 0);
  const envOtpInt = +(process.env.IMS_OTP_INTERVAL || 10);
  let OTP_INTERVAL = dbOtpInt > 0 ? dbOtpInt : envOtpInt;
  if (OTP_INTERVAL < 3) OTP_INTERVAL = 3;
  if (OTP_INTERVAL > 120) OTP_INTERVAL = 120;
  status.otpIntervalSec = OTP_INTERVAL;
  console.log(`✓ IMS fast-OTP poll every ${OTP_INTERVAL}s`);
  otpTimer = setInterval(pollOtpsNow, OTP_INTERVAL * 1000);
}

// Lightweight OTP-only poll — runs frequently between heavy ticks.
// Skips entirely if a heavy tick is in progress (which already delivers OTPs).
let _pollSkipLogCount = 0;
let _otpBusyStartedAt = 0;
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
  if (!loggedIn || !page) {
    if ((_pollSkipLogCount++ % 6) === 0) {
      console.log(`[ims-bot] fast-poll skipped — loggedIn=${loggedIn} page=${!!page}`);
    }
    return;
  }
  otpBusy = true;
  _otpBusyStartedAt = Date.now();
  try {
    const delivered = await Promise.race([
      deliverOtps(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('fast-poll timeout 18s')), 18000)),
    ]);
    status.lastScrapeAt = Math.floor(Date.now() / 1000);
    status.lastScrapeOk = true;
    if (typeof delivered === 'number' && delivered > 0) {
      console.log(`[ims-bot] fast-poll delivered ${delivered} OTP(s)`);
    }
  } catch (e) {
    status.lastScrapeOk = false;
    status.lastError = e.message;
    console.warn('[ims-bot] otp-poll:', e.message);
  } finally {
    otpBusy = false;
  }
}

async function stop() {
  if (scrapeTimer) { clearInterval(scrapeTimer); scrapeTimer = null; }
  if (otpTimer) { clearInterval(otpTimer); otpTimer = null; }
  try { await browser?.close(); } catch (_) {}
  browser = null; page = null; loggedIn = false;
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

module.exports = { start, stop, restart, tick, scrapeNow, syncLive, solveCaptchaText, getStatus, logEvent };

