// AccHub provider — REAL working integration (reverse-engineered from sms.acchub.io)
// Auth: POST /auth/login {username,password} → {access_token, user:{api_key,...}}
// Token cached in-memory & auto-refreshed on 401.
//
// Required env vars (set in backend/.env on the VPS):
//   ACCHUB_USERNAME=ShovonYE
//   ACCHUB_PASSWORD=YourPassword
//
// Optional:
//   ACCHUB_BASE_URL=https://sms.acchub.io   (default)

const axios = require('axios');

// Resolve credentials: DB settings (admin UI) override .env. Re-read every login.
function resolveCreds() {
  let dbVals = {};
  try {
    const db = require('../lib/db');
    const get = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value || '';
    dbVals = {
      base_url: get('acchub_base_url'),
      username: get('acchub_username'),
      password: get('acchub_password'),
    };
  } catch (_) { /* db not ready */ }
  return {
    BASE_URL: dbVals.base_url || process.env.ACCHUB_BASE_URL || 'https://sms.acchub.io',
    USERNAME: dbVals.username || process.env.ACCHUB_USERNAME || '',
    PASSWORD: dbVals.password || process.env.ACCHUB_PASSWORD || '',
    source: {
      base_url: dbVals.base_url ? 'database' : (process.env.ACCHUB_BASE_URL ? 'env' : 'default'),
      username: dbVals.username ? 'database' : (process.env.ACCHUB_USERNAME ? 'env' : 'none'),
      password: dbVals.password ? 'database' : (process.env.ACCHUB_PASSWORD ? 'env' : 'none'),
    },
  };
}

let cachedToken = null;
let tokenExpiresAt = 0; // unix seconds
let lastLoginError = null;

// Reset cached token (called when admin updates credentials)
function resetAuth() {
  cachedToken = null;
  tokenExpiresAt = 0;
  lastLoginError = null;
}

async function login() {
  const { BASE_URL, USERNAME, PASSWORD } = resolveCreds();
  if (!USERNAME || !PASSWORD) {
    const err = new Error('ACCHUB_USERNAME / ACCHUB_PASSWORD not set (use admin Providers page or .env)');
    lastLoginError = err.message;
    throw err;
  }
  const client = axios.create({ baseURL: BASE_URL, timeout: 20000, headers: { 'Content-Type': 'application/json' } });
  let data;
  try {
    ({ data } = await client.post('/auth/login', { username: USERNAME, password: PASSWORD }));
  } catch (e) {
    const status = e?.response?.status;
    const body = e?.response?.data;
    lastLoginError = status === 401
      ? `AccHub login 401 — wrong username/password (user: ${USERNAME})`
      : `AccHub login failed [${status || 'network'}]: ${typeof body === 'string' ? body : JSON.stringify(body || e.message)}`;
    throw new Error(lastLoginError);
  }
  if (!data?.access_token) throw new Error('AccHub login failed: no access_token');
  cachedToken = data.access_token;
  // JWT exp is in payload — decode to know when to refresh
  try {
    const payload = JSON.parse(Buffer.from(cachedToken.split('.')[1], 'base64').toString());
    tokenExpiresAt = payload.exp || (Math.floor(Date.now() / 1000) + 3600);
  } catch (_) {
    tokenExpiresAt = Math.floor(Date.now() / 1000) + 3600;
  }
  return cachedToken;
}

async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  if (!cachedToken || now >= tokenExpiresAt - 60) {
    await login();
  }
  return cachedToken;
}

async function authedRequest(method, path, opts = {}) {
  const { BASE_URL } = resolveCreds();
  const token = await getToken();
  const client = axios.create({ baseURL: BASE_URL, timeout: 20000, headers: { 'Content-Type': 'application/json' } });
  try {
    const { data } = await client.request({
      method, url: path,
      headers: { Authorization: `Bearer ${token}` },
      ...opts,
    });
    return data;
  } catch (e) {
    if (e?.response?.status === 401) {
      cachedToken = null;
      const fresh = await getToken();
      const { data } = await client.request({
        method, url: path,
        headers: { Authorization: `Bearer ${fresh}` },
        ...opts,
      });
      return data;
    }
    throw e;
  }
}

module.exports = {
  id: 'acchub',
  name: 'AccHub',
  mode: 'auto',

  async listCountries() {
    const data = await authedRequest('GET', '/api/freelancer/get-page/available-countries');
    // data.data = [{id, name, phone_code, status}]
    return (data?.data || []).map(c => ({
      id: c.id,
      name: `${c.name} (+${c.phone_code})`,
      code: c.phone_code,
    }));
  },

  async listOperators(countryId) {
    const data = await authedRequest('GET', `/api/freelancer/get-page/available-operators?country_id=${countryId}`);
    // shape: {status, data:[{id, name, ...}]}
    return (data?.data || []).map(o => ({ id: o.id, name: o.name || o.operator_name }));
  },

  async getNumber({ countryId, operatorId }) {
    if (!countryId || !operatorId) throw new Error('countryId and operatorId required');
    const data = await authedRequest('POST', '/api/freelancer/get-page/get-number', {
      data: {
        country_id: +countryId,
        operator_id: +operatorId,
        mode: 'single',
        number_format: 'full',
      },
    });
    const n = data?.data;
    if (!n?.phone_number) throw new Error(data?.message || 'AccHub: no number returned');
    return {
      // AccHub doesn't return a per-allocation ID — we use phone_number as the ref
      provider_ref: n.phone_number,
      phone_number: n.phone_number,
      operator: n.operator_name || null,
      country_code: null, // not in response; could be derived from country_id
    };
  },

  // AccHub OTP polling: there's no per-number status endpoint we found.
  // Instead, /otp-history returns recent OTPs across the account; we match by phone_number.
  // Cached briefly to avoid hammering the API when many allocations are pending.
  async checkOtp(providerRef) {
    if (!providerRef) return { otp: null, status: 'waiting' };
    const list = await this._otpHistory();
    // phone_number in history may or may not have a leading '+'
    const wanted = String(providerRef).replace(/^\+/, '');
    const match = list.find(o => String(o.phone_number || '').replace(/^\+/, '') === wanted);
    if (match?.otp_code) {
      return { otp: String(match.otp_code), status: 'received' };
    }
    return { otp: null, status: 'waiting' };
  },

  // Cached OTP history (refresh every 4s max) — used by the poller for many numbers in one tick.
  _otpCache: { at: 0, items: [] },
  async _otpHistory() {
    const now = Date.now();
    if (now - this._otpCache.at < 4000 && this._otpCache.items.length) {
      return this._otpCache.items;
    }
    try {
      const data = await authedRequest('GET', '/api/freelancer/get-page/otp-history?page=1&limit=50');
      this._otpCache = { at: now, items: data?.data || [] };
    } catch (_) {
      // keep stale cache on error
    }
    return this._otpCache.items;
  },

  async releaseNumber(providerRef) {
    // AccHub UI has no explicit release endpoint we observed; mark released locally.
    return;
  },

  // Account balance — try common endpoints; cached 30s
  _balCache: { at: 0, value: null, currency: 'USD', error: null },
  async getBalance() {
    const now = Date.now();
    if (now - this._balCache.at < 30000 && this._balCache.value !== null) {
      return { balance: this._balCache.value, currency: this._balCache.currency, cached: true };
    }
    const candidates = [
      '/api/freelancer/get-page/user-info',
      '/api/freelancer/get-page/profile',
      '/api/freelancer/get-page/dashboard',
      '/api/freelancer/get-page/wallet',
      '/api/freelancer/get-page/account',
      '/api/freelancer/profile',
      '/api/freelancer/balance',
      '/api/freelancer/wallet',
      '/api/auth/me',
      '/api/user/me',
    ];
    let lastErr = null;
    for (const path of candidates) {
      try {
        const data = await authedRequest('GET', path);
        // Try common shapes: data.balance | data.data.balance | data.user.balance
        const d = data?.data || data;
        const u = d?.user || d;
        const bal = d?.balance ?? u?.balance ?? d?.wallet_balance ?? u?.wallet_balance
                  ?? d?.amount ?? u?.amount ?? d?.account_balance ?? u?.account_balance ?? null;
        const cur = d?.currency || u?.currency || 'USD';
        if (bal !== null && bal !== undefined) {
          this._balCache = { at: now, value: Number(bal), currency: cur, error: null };
          return { balance: Number(bal), currency: cur, cached: false };
        }
      } catch (e) {
        lastErr = e?.response?.status === 404 ? null : (e.message || String(e));
      }
    }
    this._balCache = { at: now, value: null, currency: 'USD', error: lastErr || 'Balance endpoint not found' };
    return { balance: null, currency: 'USD', error: this._balCache.error };
  },

  // Reset cached token (admin updates credentials)
  resetAuth,

  // Status snapshot for admin panel
  async getStatus() {
    const { BASE_URL, USERNAME, PASSWORD, source } = resolveCreds();
    const configured = !!(USERNAME && PASSWORD);
    const out = {
      id: 'acchub',
      name: 'AccHub',
      configured,
      baseUrl: BASE_URL,
      username: USERNAME ? USERNAME.replace(/.(?=.{2})/g, '*') : null,
      loggedIn: !!cachedToken,
      tokenExpiresAt: tokenExpiresAt || null,
      balance: null,
      currency: 'USD',
      lastError: lastLoginError,
      otpHistoryCount: this._otpCache.items.length,
      source,
    };
    if (!configured) { out.lastError = 'ACCHUB_USERNAME / ACCHUB_PASSWORD not set (use Providers page Edit)'; return out; }
    try {
      const b = await this.getBalance();
      out.balance = b.balance;
      out.currency = b.currency;
      if (b.error) out.lastError = b.error;
      else if (cachedToken) lastLoginError = null;
    } catch (e) {
      out.lastError = e.message || String(e);
    }
    return out;
  },
};
