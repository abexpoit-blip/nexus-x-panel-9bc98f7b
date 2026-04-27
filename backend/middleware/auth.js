// JWT authentication middleware
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../lib/db');

const JWT_SECRET = process.env.JWT_SECRET;

// Hard-fail in production if JWT_SECRET is missing or weak
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: JWT_SECRET must be set to a strong (>=32 char) value in production.');
    process.exit(1);
  } else {
    console.warn('⚠️  JWT_SECRET is missing/weak — using dev fallback. NEVER deploy like this.');
  }
}

const SECRET = JWT_SECRET || 'dev-only-fallback-secret-do-not-use-in-prod-xxxxxxxxxxxxxxxxxx';

function hashToken(t) {
  return crypto.createHash('sha256').update(t).digest('hex');
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role },
    SECRET,
    { expiresIn: '30d' }
  );
}

function recordSession(userId, token, req) {
  const expiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
  try {
    db.prepare(`
      INSERT INTO sessions (user_id, token_hash, ip, user_agent, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(token_hash) DO UPDATE SET
        user_id = excluded.user_id,
        ip = excluded.ip,
        user_agent = excluded.user_agent,
        expires_at = excluded.expires_at,
        last_seen_at = strftime('%s','now')
    `).run(userId, hashToken(token), req.ip || null, req.headers['user-agent'] || null, expiresAt);
  } catch (e) {
    console.warn('[auth] recordSession failed:', e.message);
  }
}

// Cookie name used for httpOnly JWT
const COOKIE_NAME = 'nexus_token';

function cookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,                    // HTTPS only in prod
    sameSite: isProd ? 'lax' : 'lax',  // 'lax' works for top-level navigations + same-site XHR
    path: '/',
    maxAge: 30 * 24 * 3600 * 1000,     // 30 days
  };
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, cookieOptions());
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { ...cookieOptions(), maxAge: 0 });
}

function extractToken(req) {
  // Priority: cookie > Authorization header (so cookie clients win seamlessly)
  if (req.cookies && req.cookies[COOKIE_NAME]) return req.cookies[COOKIE_NAME];
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return null;
}

function authRequired(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = jwt.verify(token, SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (user.status === 'pending') return res.status(403).json({ error: 'Account pending admin approval' });
    if (user.status !== 'active') return res.status(403).json({ error: 'Account suspended' });
    req.user = user;
    req.token = token;
    // Pass impersonation context (set by login-as)
    if (payload.act) req.impersonator = payload.act; // { id, username }

    // Update session last_seen (best effort)
    db.prepare("UPDATE sessions SET last_seen_at = strftime('%s','now') WHERE token_hash = ?")
      .run(hashToken(token));

    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function signImpersonationToken(targetUser, adminUser) {
  return jwt.sign(
    {
      sub: targetUser.id,
      username: targetUser.username,
      role: targetUser.role,
      act: { id: adminUser.id, username: adminUser.username }, // "actor" claim
    },
    SECRET,
    { expiresIn: '2h' }   // shorter for safety
  );
}

module.exports = {
  authRequired, adminOnly, signToken, recordSession, hashToken,
  JWT_SECRET: SECRET, COOKIE_NAME, setAuthCookie, clearAuthCookie,
  extractToken, signImpersonationToken,
};
