// IMS Browser Bot — runs a headless Chrome that stays logged into imssms.org
// and scrapes the manager's number list + OTP inbox at a fixed interval.
//
// On startup: loads .env credentials, opens a single browser instance.
// Every IMS_SCRAPE_INTERVAL seconds:
//   1) Open the "Numbers" page → find any new numbers added by manager → push into our `allocations` pool.
//   2) Open the "Inbox/OTP" page → for each received OTP, match by phone_number to an active allocation → credit the agent.
//
// IMPORTANT — IMS UI selectors are PLACEHOLDERS:
//   The exact CSS selectors below MUST be adjusted once we can inspect the live IMS panel HTML.
//   On the VPS, run: `node backend/workers/imsBot.js --inspect` to dump the page so we can refine selectors.
//
// This file is SAFE to require even when IMS_ENABLED=false — start() will be a no-op.

const path = require('path');
const fs = require('fs');
const db = require('../lib/db');
const { markOtpReceived } = require('../routes/numbers');

const ENABLED = String(process.env.IMS_ENABLED || 'false').toLowerCase() === 'true';
const BASE_URL = process.env.IMS_BASE_URL || 'https://www.imssms.org';
const USERNAME = process.env.IMS_USERNAME || '';
const PASSWORD = process.env.IMS_PASSWORD || '';
const HEADLESS = String(process.env.IMS_HEADLESS || 'true').toLowerCase() !== 'false';
const CHROME_PATH = process.env.IMS_CHROME_PATH || undefined;
const INTERVAL = +(process.env.IMS_SCRAPE_INTERVAL || 8);

let browser = null;
let page = null;
let busy = false;
let consecFail = 0;

async function ensureBrowser() {
  if (browser && page) return;
  const puppeteer = require('puppeteer');
  browser = await puppeteer.launch({
    headless: HEADLESS ? 'new' : false,
    executablePath: CHROME_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent('Mozilla/5.0 NexusXBot/1.0');
  await login();
}

async function login() {
  console.log('[ims-bot] logging in to', BASE_URL);
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle2', timeout: 30000 });

  // PLACEHOLDER selectors — tune after first run on VPS using --inspect
  const userSel = 'input[name="username"], input[name="user"], input[type="text"]';
  const passSel = 'input[name="password"], input[type="password"]';
  const submitSel = 'button[type="submit"], input[type="submit"], button:has-text("Login")';

  await page.waitForSelector(userSel, { timeout: 15000 });
  await page.type(userSel, USERNAME, { delay: 30 });
  await page.type(passSel, PASSWORD, { delay: 30 });
  await Promise.all([
    page.click(submitSel).catch(() => page.keyboard.press('Enter')),
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null),
  ]);
  console.log('[ims-bot] login submitted, current url =', page.url());
}

// Scrape the numbers page — return [{phone_number, country_code?, operator?}]
async function scrapeNumbers() {
  // PLACEHOLDER — adjust to real IMS URL & table structure
  await page.goto(`${BASE_URL}/numbers`, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => null);
  return await page.evaluate(() => {
    const rows = document.querySelectorAll('table tbody tr');
    const out = [];
    rows.forEach(r => {
      const cells = r.querySelectorAll('td');
      if (!cells.length) return;
      const text = Array.from(cells).map(c => c.innerText.trim());
      // Heuristic: find a phone-number-like cell
      const phone = text.find(t => /^\+?\d{8,15}$/.test(t.replace(/\s/g, '')));
      if (phone) out.push({ phone_number: phone.replace(/\s/g, ''), raw: text });
    });
    return out;
  });
}

// Scrape inbox — return [{phone_number, otp_code, sms_text?}]
async function scrapeInbox() {
  await page.goto(`${BASE_URL}/inbox`, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => null);
  return await page.evaluate(() => {
    const rows = document.querySelectorAll('table tbody tr');
    const out = [];
    rows.forEach(r => {
      const cells = r.querySelectorAll('td');
      if (cells.length < 2) return;
      const text = Array.from(cells).map(c => c.innerText.trim());
      const phone = text.find(t => /^\+?\d{8,15}$/.test(t.replace(/\s/g, '')));
      const sms = text.find(t => /\d{3,8}/.test(t) && t.length > 10);
      if (!phone || !sms) return;
      const m = sms.match(/(\d{4,8})/);
      if (m) out.push({ phone_number: phone.replace(/\s/g, ''), otp_code: m[1], sms_text: sms });
    });
    return out;
  });
}

// One full pass: refresh number pool + dispatch OTPs.
async function tick() {
  if (busy) return;
  busy = true;
  try {
    await ensureBrowser();

    // 1) Numbers → pool
    let nums = [];
    try { nums = await scrapeNumbers(); } catch (e) { console.warn('[ims-bot] scrapeNumbers failed:', e.message); }
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
          ins.run(sysUser.id, n.phone_number, null, null);
          added++;
        }
      });
      tx(nums);
      if (added) console.log(`[ims-bot] pool: +${added} new numbers`);
    }

    // 2) OTPs → match & credit
    let otps = [];
    try { otps = await scrapeInbox(); } catch (e) { console.warn('[ims-bot] scrapeInbox failed:', e.message); }
    for (const o of otps) {
      const a = db.prepare(`
        SELECT * FROM allocations
        WHERE provider='ims' AND phone_number=? AND status='active' AND otp IS NULL
        ORDER BY allocated_at DESC LIMIT 1
      `).get(o.phone_number);
      if (a) {
        await markOtpReceived(a, o.otp_code);
        console.log(`[ims-bot] OTP delivered: ${o.phone_number} → ${o.otp_code} (alloc#${a.id})`);
      }
    }

    consecFail = 0;
  } catch (e) {
    consecFail++;
    console.error('[ims-bot] tick failed:', e.message);
    // After 3 failures, recycle the browser (likely session expired or page crashed)
    if (consecFail >= 3) {
      console.warn('[ims-bot] recycling browser after repeated failures');
      try { await browser?.close(); } catch (_) {}
      browser = null; page = null;
      consecFail = 0;
    }
  } finally {
    busy = false;
  }
}

function start() {
  if (!ENABLED) {
    console.log('✗ IMS bot disabled (set IMS_ENABLED=true to enable)');
    return;
  }
  if (!USERNAME || !PASSWORD) {
    console.warn('✗ IMS bot: IMS_USERNAME / IMS_PASSWORD not set, skipping');
    return;
  }
  console.log(`✓ IMS bot starting (every ${INTERVAL}s, headless=${HEADLESS})`);
  // First run after 5s so server can finish booting
  setTimeout(tick, 5000);
  setInterval(tick, INTERVAL * 1000);
}

async function stop() {
  try { await browser?.close(); } catch (_) {}
  browser = null; page = null;
}

// CLI helper: `node backend/workers/imsBot.js --inspect`
if (require.main === module && process.argv.includes('--inspect')) {
  require('dotenv').config();
  (async () => {
    process.env.IMS_HEADLESS = 'false';
    await ensureBrowser();
    console.log('Inspector mode: browser opened. URL:', page.url());
    console.log('Navigate manually, then press Ctrl+C. Page HTML will be saved to ims-page.html.');
    process.on('SIGINT', async () => {
      const html = await page.content();
      fs.writeFileSync('ims-page.html', html);
      console.log('Saved ims-page.html');
      await stop();
      process.exit(0);
    });
  })();
}

module.exports = { start, stop, tick };
