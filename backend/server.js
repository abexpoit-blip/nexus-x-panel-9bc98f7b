// NexusX Backend — Express + SQLite
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');

// Ensure DB exists & schema applied + admin seeded
require('./db/init');

const app = express();

// Trust proxy (nginx) so req.ip is the real client IP
app.set('trust proxy', 1);

// Security headers (helmet)
app.use(helmet({
  contentSecurityPolicy: false,             // SPA + external CDNs — handled by nginx
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// CORS — explicit allow-list in production
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
  : null;

if (process.env.NODE_ENV === 'production' && !corsOrigins) {
  console.error('FATAL: CORS_ORIGIN env var required in production (comma-separated origins).');
  process.exit(1);
}

app.use(cors({
  // When credentials:true the browser requires an explicit origin (no '*'),
  // so in dev we reflect the request origin instead of using `true`.
  origin: corsOrigins || ((origin, cb) => cb(null, origin || true)),
  credentials: true,
}));

app.use(cookieParser());                     // read httpOnly auth cookie
app.use(express.json({ limit: '256kb' }));   // tighter body cap

// HTTP logs — production: only errors/4xx/5xx + skip noisy polling endpoints.
// Dev: full 'dev' format.
if (process.env.NODE_ENV === 'production') {
  app.use(morgan('tiny', {
    skip: (req, res) => {
      // skip 2xx/3xx (success/redirect) — keep only errors
      if (res.statusCode < 400) return true;
      return false;
    },
  }));
} else {
  app.use(morgan('dev', {
    skip: (req) => {
      // even in dev, mute the loudest pollers
      const url = req.originalUrl || req.url || '';
      return /^\/api\/(notifications|admin\/(ims-status|msi-status)|health)(\?|$)/.test(url);
    },
  }));
}

// Global rate limiter
app.use('/api', rateLimit({
  windowMs: +(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
  max: +(process.env.RATE_LIMIT_MAX || 120),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down.' },
}));

// Strict limiter on auth endpoints (brute force protection)
const authLimiter = rateLimit({
  windowMs: 15 * 60_000,                    // 15 minutes
  max: 10,                                  // 10 login/register attempts per IP
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,             // only count failures
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/numbers', require('./routes/numbers'));
app.use('/api/rates', require('./routes/rates'));
app.use('/api/cdr', require('./routes/cdr'));
app.use('/api', require('./routes/payments'));            // /payments + /withdrawals
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/leaderboard', require('./routes/leaderboard'));
app.use('/api', require('./routes/security'));            // /audit + /sessions + /settings
app.use('/api/admin/tgbot', require('./routes/tgbot'));   // Telegram bot admin

// Health
app.get('/api/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

// 404
app.use('/api', (_, res) => res.status(404).json({ error: 'Not found' }));

// Error handler — never leak stack traces in production
app.use((err, req, res, next) => {
  console.error(err);
  const safeMsg = process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : (err.message || 'Internal server error');
  res.status(err.status || 500).json({ error: safeMsg });
});

const PORT = +(process.env.PORT || 4000);
app.listen(PORT, () => {
  console.log(`\n🚀 NexusX backend listening on http://localhost:${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   CORS origin: ${corsOrigins ? corsOrigins.join(', ') : '(allow all — dev only)'}\n`);

  // Start OTP poller (AccHub auto polling) after server is up
  require('./workers/otpPoller').start();

  // Start IMS browser bot (no-op if IMS_ENABLED=false)
  require('./workers/imsBot').start();

  // Start MSI browser bot (no-op if MSI_ENABLED=false)
  require('./workers/msiBot').start();

  // Start NumPanel bot (no-op if NUMPANEL_ENABLED=false)
  try { require('./workers/numpanelBot').start(); }
  catch (e) { console.warn('numpanel bot start error:', e.message); }

  // Start IPRN bot (no-op if IPRN_ENABLED=false). HTTP-only — no browser needed.
  try { require('./workers/iprnBot').start(); }
  catch (e) { console.warn('iprn bot start error:', e.message); }

  // Start IPRN-SMS bot (no-op if IPRN_SMS_ENABLED=false). HTTP-only.
  try { require('./workers/iprnSmsBot').start(); }
  catch (e) { console.warn('iprn_sms bot start error:', e.message); }

  // Start Seven1Tel bot (no-op if SEVEN1TEL_ENABLED=false). Same /ints panel as MSI.
  try { require('./workers/seven1telBot').start(); }
  catch (e) { console.warn('seven1tel bot start error:', e.message); }
});
