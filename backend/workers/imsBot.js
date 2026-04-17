// IMS Browser Bot — runs a headless Chrome that stays logged into imssms.org
// and scrapes the manager's numbers + OTP CDRs at a fixed interval.
//
// Real IMS panel structure (verified by user screenshot):
//   /login           → form with username, password, and a CALCULATOR CAPTCHA (e.g. "5 + 3 = ?")
//   /client/SMSCDRStats → "SMS CDRs" page (DATE | RANGE | NUMBER | CLI | SMS | CURRENCY | MY PAYOUT)
//                          The "SMS" cell contains the OTP text — we extract digits.
//   /client/SMSNumbers  → "SMS Numbers" page (list of available phone numbers)
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

const ENABLED = String(process.env.IMS_ENABLED || 'false').toLowerCase() === 'true';
const BASE_URL = (process.env.IMS_BASE_URL || 'https://www.imssms.org').replace(/\/$/, '');
const USERNAME = process.env.IMS_USERNAME || '';
const PASSWORD = process.env.IMS_PASSWORD || '';
const HEADLESS = String(process.env.IMS_HEADLESS || 'true').toLowerCase() !== 'false';
const CHROME_PATH = process.env.IMS_CHROME_PATH || undefined;
const INTERVAL = +(process.env.IMS_SCRAPE_INTERVAL || 8);

let browser = null;
let page = null;
let busy = false;
let consecFail = 0;
let loggedIn = false;
let emptyStreak = 0;        // consecutive scrapes returning 0 numbers
let scrapeTimer = null;     // for graceful stop
const EMPTY_LIMIT = +(process.env.IMS_EMPTY_LIMIT || 10);

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
    return { ...status, poolSize, activeAssigned, otpReceived, events: events.slice() };
  } catch (_) {
    return { ...status, poolSize: 0, activeAssigned: 0, otpReceived: 0, events: events.slice() };
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
  const puppeteer = require('puppeteer');
  browser = await puppeteer.launch({
    headless: HEADLESS ? 'new' : false,
    executablePath: CHROME_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 NexusXBot/1.0');
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
  console.log('[ims-bot] navigating to login page');
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle2', timeout: 30000 });

  // Fill username + password (try common selectors)
  const userSel = 'input[name="username"], input[name="user"], input[name="email"], input[type="text"]:not([readonly])';
  const passSel = 'input[name="password"], input[type="password"]';
  await page.waitForSelector(userSel, { timeout: 15000 });
  await page.click(userSel, { clickCount: 3 }).catch(() => {});
  await page.type(userSel, USERNAME, { delay: 25 });
  await page.click(passSel, { clickCount: 3 }).catch(() => {});
  await page.type(passSel, PASSWORD, { delay: 25 });

  // Find captcha question — usually a label/span near a captcha input
  const { captchaText, captchaSel } = await page.evaluate(() => {
    // Find an input that looks like the captcha answer field (small, numeric, near the word "captcha" or "= ?")
    const inputs = Array.from(document.querySelectorAll('input'));
    for (const inp of inputs) {
      if (inp.type === 'hidden' || inp.type === 'password') continue;
      if (inp.name === 'username' || inp.name === 'user' || inp.name === 'email') continue;
      // Look at surrounding text for a math expression
      const parent = inp.closest('div,form,fieldset,td,tr,label') || inp.parentElement;
      const text = (parent?.innerText || '') + ' ' + (inp.placeholder || '');
      if (/[\d]\s*[+\-x×*/÷]\s*[\d]/.test(text) || /captcha/i.test(text)) {
        return { captchaText: text, captchaSel: inp.name ? `input[name="${inp.name}"]` : null };
      }
    }
    return { captchaText: null, captchaSel: null };
  });

  if (captchaText && captchaSel) {
    const answer = solveCaptchaText(captchaText);
    if (answer) {
      console.log(`[ims-bot] captcha "${captchaText.replace(/\s+/g,' ').trim().slice(0,60)}" → ${answer}`);
      await page.click(captchaSel, { clickCount: 3 }).catch(() => {});
      await page.type(captchaSel, answer, { delay: 25 });
    } else {
      console.warn('[ims-bot] captcha detected but could not solve:', captchaText.slice(0, 100));
    }
  } else {
    console.log('[ims-bot] no captcha detected on login page');
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
  console.log(`[ims-bot] login ${ok ? '✓' : '✗'} (url=${url})`);
  if (!ok) {
    // Common cause: wrong captcha. Throw so caller retries.
    throw new Error('IMS login failed (likely captcha) — will retry');
  }
}

// ---- Scrape SMS Numbers page (the manager's available numbers) ----
async function scrapeNumbers() {
  await page.goto(`${BASE_URL}/client/SMSNumbers`, { waitUntil: 'networkidle2', timeout: 25000 }).catch(() => null);
  // If session died, will redirect to /login → re-login next tick
  if (/\/login/i.test(page.url())) { loggedIn = false; return []; }
  return await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('table tbody tr').forEach((row) => {
      const cells = Array.from(row.querySelectorAll('td')).map(c => c.innerText.trim());
      if (!cells.length) return;
      // A row may contain: range, number, status, etc. Find the cell that is a phone number.
      const phone = cells.find(t => /^\+?\d{8,15}$/.test(t.replace(/[\s-]/g, '')));
      if (!phone) return;
      // Range/operator usually a non-numeric text cell (e.g. "Peru Bitel TF04")
      const range = cells.find(t => /[A-Za-z]/.test(t) && t.length < 60 && t !== phone);
      out.push({
        phone_number: phone.replace(/[\s-]/g, ''),
        operator: range || null,
      });
    });
    return out;
  });
}

// ---- Scrape SMS CDRs (the OTP/SMS log) ----
// Columns: DATE | RANGE | NUMBER | CLI | SMS | CURRENCY | MY PAYOUT
async function scrapeOtps() {
  await page.goto(`${BASE_URL}/client/SMSCDRStats`, { waitUntil: 'networkidle2', timeout: 25000 }).catch(() => null);
  if (/\/login/i.test(page.url())) { loggedIn = false; return []; }
  return await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('table tbody tr').forEach((row) => {
      const cells = Array.from(row.querySelectorAll('td')).map(c => c.innerText.trim());
      if (cells.length < 5) return;
      // Heuristic find: phone is purely digits 8-15 long; sms is the longest non-numeric-only cell
      const phone = cells.find(t => /^\+?\d{8,15}$/.test(t.replace(/[\s-]/g, '')));
      if (!phone) return;
      // SMS cell = the cell with the most letters (the message text)
      let sms = '';
      for (const c of cells) {
        if (c === phone) continue;
        if (/[A-Za-z\u0980-\u09FF\u1000-\u109F]/.test(c) && c.length > sms.length) sms = c;
      }
      // Extract OTP — first 4-8 digit standalone number in sms text
      const m = sms.match(/(?:^|[^\d])(\d{4,8})(?:[^\d]|$)/);
      if (!m) return;
      out.push({
        phone_number: phone.replace(/[\s-]/g, ''),
        otp_code: m[1],
        sms_text: sms.slice(0, 200),
      });
    });
    return out;
  });
}

// One full pass.
async function tick() {
  if (busy) return;
  busy = true;
  try {
    await ensureBrowser();
    if (!loggedIn) await login();

    // 1) Numbers → pool
    const nums = await scrapeNumbers().catch((e) => { console.warn('[ims-bot] scrapeNumbers:', e.message); return []; });
    if (nums.length) {
      let sysUser = db.prepare("SELECT id FROM users WHERE username = '__ims_pool__'").get();
      if (!sysUser) {
        const r = db.prepare(`INSERT INTO users (username, password_hash, role, status) VALUES ('__ims_pool__', '!', 'agent', 'suspended')`).run();
        sysUser = { id: r.lastInsertRowid };
      }
      const exists = db.prepare("SELECT 1 FROM allocations WHERE provider='ims' AND phone_number=? LIMIT 1");
      const ins = db.prepare(`
        INSERT INTO allocations (user_id, provider, phone_number, country_code, operator, status, allocated_at)
        VALUES (?, 'ims', ?, ?, ?, 'pool', strftime('%s','now'))
      `);
      let added = 0;
      const tx = db.transaction((arr) => {
        for (const n of arr) {
          if (exists.get(n.phone_number)) continue;
          ins.run(sysUser.id, n.phone_number, null, n.operator || null);
          added++;
        }
      });
      tx(nums);
      status.numbersScrapedTotal += nums.length;
      status.numbersAddedTotal += added;
      if (added) {
        console.log(`[ims-bot] pool: +${added} new numbers (total scraped ${nums.length})`);
        logEvent('success', `Pool +${added} new numbers`, { scraped: nums.length });
      }

      // Auto-pause: track consecutive empty scrapes
      if (nums.length === 0) {
        emptyStreak++;
        if (emptyStreak >= EMPTY_LIMIT) {
          const msg = `IMS bot auto-paused: ${EMPTY_LIMIT} consecutive empty scrapes`;
          console.warn(`[ims-bot] ${msg}`);
          logEvent('warn', msg);
          notifyAdmins('IMS Bot Auto-Paused', `No numbers found in last ${EMPTY_LIMIT} scrapes. Bot stopped to save resources. Click Start when IMS has stock.`, 'warning');
          await stop();
          emptyStreak = 0;
          return;
        }
      } else {
        emptyStreak = 0;
      }
    }

    // 2) OTPs → match active allocations & credit
    const otps = await scrapeOtps().catch((e) => { console.warn('[ims-bot] scrapeOtps:', e.message); return []; });
    for (const o of otps) {
      const a = db.prepare(`
        SELECT * FROM allocations
        WHERE provider='ims' AND phone_number=? AND status='active' AND otp IS NULL
        ORDER BY allocated_at DESC LIMIT 1
      `).get(o.phone_number);
      if (a) {
        await markOtpReceived(a, o.otp_code);
        status.otpsDeliveredTotal++;
        console.log(`[ims-bot] OTP delivered: ${o.phone_number} → ${o.otp_code} (alloc#${a.id})`);
        logEvent('success', `OTP delivered to ${o.phone_number}`, { otp: o.otp_code, alloc: a.id });
      }
    }

    consecFail = 0;
    status.consecFail = 0;
    status.lastScrapeAt = Math.floor(Date.now() / 1000);
    status.lastScrapeOk = true;
    status.totalScrapes++;
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

// Notify all admins (broadcast-style — one row per admin user)
function notifyAdmins(title, message, type = 'warning') {
  try {
    const admins = db.prepare("SELECT id FROM users WHERE role='admin'").all();
    const ins = db.prepare("INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)");
    for (const a of admins) ins.run(a.id, title, message, type);
  } catch (e) {
    console.warn('[ims-bot] notifyAdmins failed:', e.message);
  }
}

function start() {
  status.enabled = ENABLED;
  status.baseUrl = BASE_URL;
  status.intervalSec = INTERVAL;
  if (!ENABLED) {
    console.log('✗ IMS bot disabled (set IMS_ENABLED=true to enable)');
    return;
  }
  if (!USERNAME || !PASSWORD) {
    console.warn('✗ IMS bot: IMS_USERNAME / IMS_PASSWORD not set');
    status.lastError = 'IMS_USERNAME / IMS_PASSWORD not set';
    return;
  }
  if (scrapeTimer) { clearInterval(scrapeTimer); scrapeTimer = null; }
  status.running = true;
  emptyStreak = 0;
  console.log(`✓ IMS bot starting (every ${INTERVAL}s, headless=${HEADLESS}, base=${BASE_URL})`);
  setTimeout(tick, 5000);
  scrapeTimer = setInterval(tick, INTERVAL * 1000);
}

async function stop() {
  if (scrapeTimer) { clearInterval(scrapeTimer); scrapeTimer = null; }
  try { await browser?.close(); } catch (_) {}
  browser = null; page = null; loggedIn = false;
  status.running = false;
  status.loggedIn = false;
}

// CLI: `node workers/imsBot.js --inspect`  → opens visible browser & dumps HTML on Ctrl+C
if (require.main === module && process.argv.includes('--inspect')) {
  require('dotenv').config();
  (async () => {
    process.env.IMS_HEADLESS = 'false';
    await ensureBrowser();
    await login().catch((e) => console.warn('login failed:', e.message));
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

module.exports = { start, stop, restart, tick, solveCaptchaText, getStatus, logEvent };
