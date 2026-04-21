#!/usr/bin/env node
/**
 * iprndata HTTP login Proof-of-Concept
 * (sync trigger v2)
 * ---------------------------------------------------------------
 * Goal: confirm we can login + scrape WITHOUT puppeteer (axios only).
 * If this works → iprnBot will be 5x lighter than imsBot/msiBot.
 *
 * Run on VPS:
 *   cd /opt/nexus/nexus-x-panel/backend
 *   node scripts/iprndata-login-poc.js
 *
 * Required env:
 *   IPRN_USERNAME=your_username
 *   IPRN_PASSWORD=your_password
 */

const axios = require('axios');

// ---- config ----------------------------------------------------
const BASE = 'https://iprndata.com';
const USERNAME = process.env.IPRN_USERNAME;
const PASSWORD = process.env.IPRN_PASSWORD;

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ---- tiny cookie jar (no extra deps) ---------------------------
const cookies = new Map(); // name -> value

function cookieHeader() {
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function absorbSetCookie(headers) {
  const sc = headers['set-cookie'];
  if (!sc) return;
  for (const line of sc) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    cookies.set(name, value);
  }
}

// ---- shared axios with cookies ---------------------------------
const http = axios.create({
  baseURL: BASE,
  maxRedirects: 0, // we follow manually so we can capture cookies + 302 chain
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
  (res) => {
    absorbSetCookie(res.headers);
    return res;
  },
  (err) => {
    if (err.response) absorbSetCookie(err.response.headers);
    return Promise.reject(err);
  }
);

async function followRedirect(res) {
  let cur = res;
  let hops = 0;
  while ([301, 302, 303, 307, 308].includes(cur.status) && hops < 5) {
    const loc = cur.headers.location;
    if (!loc) break;
    console.log(`  ↪ redirect → ${loc}`);
    cur = await http.get(loc.startsWith('http') ? loc : loc);
    hops++;
  }
  return cur;
}

// ---- helpers ---------------------------------------------------
function extractCsrfFromHtml(html) {
  // Yii2 puts both <meta name="csrf-token"> and a hidden form input.
  const meta =
    html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/i) ||
    html.match(/name="_csrf-frontend"\s+value="([^"]+)"/i) ||
    html.match(/name="_csrf"\s+value="([^"]+)"/i);
  return meta ? meta[1] : null;
}

function extractFormFieldName(html) {
  // Returns the actual hidden csrf field name used by the form (varies per Yii2 install)
  const m = html.match(/name="(_csrf[^"]*)"/i);
  return m ? m[1] : '_csrf-frontend';
}

// ---- main ------------------------------------------------------
(async function main() {
  console.log('━━━ iprndata HTTP login POC ━━━');
  if (!USERNAME || !PASSWORD) {
    console.error('✗ Missing env: set IPRN_USERNAME and IPRN_PASSWORD before running this script.');
    process.exit(1);
  }
  console.log(`User: ${USERNAME}`);

  // 1. GET login page → cookies + csrf
  console.log('\n▶ Step 1: GET /user-management/auth/login');
  let res = await http.get('/user-management/auth/login');
  console.log(`  status=${res.status} bytes=${res.data.length}`);
  console.log(`  cookies after GET:`, [...cookies.keys()].join(', ') || '(none)');
  const csrfToken = extractCsrfFromHtml(res.data);
  const csrfField = extractFormFieldName(res.data);
  console.log(`  csrf field name: ${csrfField}`);
  console.log(`  csrf token: ${csrfToken ? csrfToken.slice(0, 24) + '…' : '(NOT FOUND)'}`);
  if (!csrfToken) {
    console.error('✗ Could not extract CSRF token. Aborting.');
    process.exit(1);
  }

  // 2. POST credentials
  console.log('\n▶ Step 2: POST /user-management/auth/login');
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
        Origin: BASE,
        Referer: `${BASE}/user-management/auth/login`,
      },
    });
  } catch (e) {
    if (e.response) res = e.response;
    else throw e;
  }
  console.log(`  status=${res.status}`);
  if (res.status >= 300 && res.status < 400) {
    console.log(`  redirect → ${res.headers.location}`);
    res = await followRedirect(res);
  }
  console.log(`  cookies after POST:`, [...cookies.keys()].join(', '));

  // 3. Verify session — GET /dashboard (logged-in users only)
  console.log('\n▶ Step 3: GET /dashboard (auth-gated)');
  res = await http.get('/dashboard');
  if ([301, 302, 303].includes(res.status)) res = await followRedirect(res);
  console.log(`  status=${res.status} bytes=${res.data.length}`);
  const isLoggedIn =
    res.data.includes(USERNAME) ||
    res.data.includes('MARGIN TREND') ||
    res.data.includes('Dashboard');
  console.log(`  contains username/dashboard markers: ${isLoggedIn ? '✓ YES' : '✗ NO'}`);
  if (!isLoggedIn) {
    console.error(
      '\n✗ Login appears to have FAILED. Falling back to puppeteer will be required.'
    );
    console.log('--- first 800 chars of /dashboard response ---');
    console.log(res.data.slice(0, 800));
    process.exit(2);
  }

  // 4. Scrape billing-groups (number ranges/pools)
  console.log('\n▶ Step 4: GET /billing-groups/index (number ranges)');
  res = await http.get('/billing-groups/index');
  console.log(`  status=${res.status} bytes=${res.data.length}`);
  // Quick row count from <tbody>
  const tbodyMatch = res.data.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  const rowCount = tbodyMatch ? (tbodyMatch[1].match(/<tr/gi) || []).length : 0;
  console.log(`  rows in pool table: ${rowCount}`);
  // Show first row text snippet
  if (tbodyMatch) {
    const firstRow = (tbodyMatch[1].match(/<tr[\s\S]*?<\/tr>/i) || [''])[0];
    const text = firstRow.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    console.log(`  first row text: ${text.slice(0, 200)}…`);
  }

  // 5. Scrape recent SMS records (OTP feed)
  console.log('\n▶ Step 5: GET /sms-records/index (OTP feed)');
  res = await http.get('/sms-records/index');
  console.log(`  status=${res.status} bytes=${res.data.length}`);
  const smsMatch = res.data.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  const smsRows = smsMatch ? (smsMatch[1].match(/<tr/gi) || []).length : 0;
  console.log(`  sms rows visible (today): ${smsRows}`);

  console.log('\n━━━ ✅ POC SUCCESS — HTTP-only path works ━━━');
  console.log('Cookies for session reuse:', [...cookies.keys()].join(', '));
})().catch((e) => {
  console.error('\n✗ POC failed:', e.message);
  if (e.response) {
    console.error(`  http status: ${e.response.status}`);
    console.error(`  body snippet: ${String(e.response.data).slice(0, 400)}`);
  }
  process.exit(1);
});