// NEXUS X — Telegram Bot worker
// Runs as a separate pm2 process: nexus-tgbot
// Shares the SQLite DB with nexus-backend (same allocations pool, hybrid range toggle).

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { Telegraf, Markup } = require('telegraf');
const db = require('../lib/db');
const { bestCountryCode, countryName: ccName, flagOf: ccFlag, COUNTRY_NAMES: CC_NAMES } = require('../lib/countryInfer');

const TOKEN = process.env.TG_BOT_TOKEN;
if (!TOKEN) {
  console.error('FATAL: TG_BOT_TOKEN env var is required');
  process.exit(1);
}

const NUMBERS_PER_BATCH = +(process.env.TG_BATCH_SIZE || 10);
const EXPIRY_SEC        = +(process.env.TG_EXPIRY_SEC || 1800);   // 30 min
const EXPIRY_MIN        = Math.round(EXPIRY_SEC / 60);
const SUPPORT_URL       = process.env.TG_SUPPORT_URL || 'https://t.me/';
const SITE_URL          = process.env.TG_SITE_URL || 'https://nexus-x.site';

// ---------- Public OTP history channel (admin configurable) ----------
// Admin sets setting key `tg_public_channel` to a channel/group chat id like -1001234567890.
// Every received OTP is posted there with number & OTP last-4 masked.
function getPublicChannelId() {
  try {
    const v = db.prepare("SELECT value FROM settings WHERE key = 'tg_public_channel'").get()?.value;
    if (!v) return null;
    const n = String(v).trim();
    return n || null;
  } catch { return null; }
}

const bot = new Telegraf(TOKEN);

// ---------- Helpers ----------
const now = () => Math.floor(Date.now() / 1000);
const fmtBdt = (n) => `৳${Number(n || 0).toFixed(2)}`;
const fmtTime = (sec) => {
  if (!sec) return '—';
  const d = new Date(sec * 1000);
  return d.toLocaleString('en-GB', { hour12: false });
};
const fmtAgo = (sec) => {
  if (!sec) return 'never';
  const s = now() - sec;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

// Country code → flag emoji (delegated to shared helper)
const flagOf = ccFlag;
const COUNTRY_NAMES = CC_NAMES;
const countryName = ccName;

// Service icon
function serviceIcon(svc) {
  if (!svc) return '📡';
  const s = String(svc).toLowerCase();
  if (s.includes('facebook')) return '🟦';
  if (s.includes('whatsapp')) return '🟢';
  if (s.includes('telegram')) return '✈️';
  if (s.includes('tiktok'))   return '🎵';
  if (s.includes('instagram'))return '📷';
  if (s.includes('google'))   return '🔍';
  if (s.includes('twitter') || s.includes('x.com')) return '🐦';
  return '📡';
}

// ---------- TG user ensure ----------
function ensureTgUser(ctx) {
  const u = ctx.from;
  if (!u) return null;
  const existing = db.prepare('SELECT * FROM tg_users WHERE tg_user_id = ?').get(u.id);
  if (existing) {
    db.prepare('UPDATE tg_users SET last_seen_at = ?, username = ?, first_name = ? WHERE tg_user_id = ?')
      .run(now(), u.username || null, u.first_name || null, u.id);
    return existing;
  }
  db.prepare(`
    INSERT INTO tg_users (tg_user_id, username, first_name, language)
    VALUES (?, ?, ?, ?)
  `).run(u.id, u.username || null, u.first_name || null, u.language_code || 'en');
  console.log(`[tgbot] new user: ${u.id} @${u.username || u.first_name}`);
  return db.prepare('SELECT * FROM tg_users WHERE tg_user_id = ?').get(u.id);
}

function isBanned(tgUser) { return tgUser && tgUser.status === 'banned'; }

// ---------- Main menu ----------
function mainMenuKeyboard() {
  return Markup.keyboard([
    ['🌍 Get Number', '📞 My Numbers'],
    ['📥 OTP History', '🏆 Leaderboard'],
    ['💰 Wallet', 'ℹ️ Support'],
  ]).resize();
}

function welcomeText(u) {
  const nm = u.first_name || u.username || 'friend';
  return (
    `<b>👋 Welcome ${escapeHtml(nm)}!</b>\n\n` +
    `🚀 <b>NEXUS X — Number Panel</b>\n` +
    `Fast, reliable virtual numbers for OTP verification.\n\n` +
    `💰 Balance: <b>${fmtBdt(u.balance_bdt)}</b>\n` +
    `📊 Total OTPs: <b>${u.total_otps}</b>\n\n` +
    `Tap a button below to begin.`
  );
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// Mask last 4 digits with 'XXXX' (e.g. 95415646XXXX)
function maskLast4(s) {
  if (!s) return '';
  const str = String(s);
  if (str.length <= 4) return 'XXXX';
  return str.slice(0, str.length - 4) + 'XXXX';
}

function newBatchId() {
  return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ---------- Country list (only TG-enabled ranges with pool > 0) ----------
// Country code is inferred from range_name when allocations.country_code is missing
function listCountries() {
  const rows = db.prepare(`
    SELECT a.country_code AS raw_cc, COALESCE(a.operator,'Unknown') AS range_name, COUNT(*) AS cnt
    FROM allocations a
    JOIN range_tg_settings r
      ON r.provider = a.provider
     AND r.range_name = COALESCE(a.operator, 'Unknown')
    WHERE a.status = 'pool' AND r.tg_enabled = 1
    GROUP BY a.country_code, range_name
  `).all();
  const agg = new Map();
  for (const r of rows) {
    const cc = bestCountryCode(r.raw_cc, r.range_name) || 'XX';
    agg.set(cc, (agg.get(cc) || 0) + r.cnt);
  }
  return Array.from(agg.entries())
    .map(([code, cnt]) => ({ code, cnt }))
    .filter(r => r.cnt > 0)
    .sort((a, b) => b.cnt - a.cnt || a.code.localeCompare(b.code));
}

function listRangesForCountry(cc) {
  const rows = db.prepare(`
    SELECT a.provider, COALESCE(a.operator, 'Unknown') AS range_name, a.country_code AS raw_cc,
           r.service, r.tg_rate_bdt, COUNT(*) AS cnt
    FROM allocations a
    JOIN range_tg_settings r
      ON r.provider = a.provider
     AND r.range_name = COALESCE(a.operator, 'Unknown')
    WHERE a.status = 'pool' AND r.tg_enabled = 1
    GROUP BY a.provider, range_name, a.country_code, r.service, r.tg_rate_bdt
  `).all();
  return rows
    .filter(r => (bestCountryCode(r.raw_cc, r.range_name) || 'XX') === cc && r.cnt > 0)
    .sort((a, b) => b.cnt - a.cnt || a.range_name.localeCompare(b.range_name));
}

// ---------- Atomic claim N numbers ----------
// `cc` is the *intended* country (possibly inferred). We match either the
// real country_code column or fall back to range-name inference.
function claimBatch(provider, rangeName, cc, count) {
  const sel = db.prepare(`
    SELECT id, phone_number, operator, country_code
    FROM allocations
    WHERE provider = ? AND COALESCE(operator,'Unknown') = ? AND status = 'pool'
    ORDER BY allocated_at ASC
    LIMIT ?
  `);
  const claim = db.prepare("UPDATE allocations SET status='claiming' WHERE id = ? AND status = 'pool'");
  const won = [];
  const candidates = sel.all(provider, rangeName, count * 5);
  for (const c of candidates) {
    if (won.length >= count) break;
    const rowCc = bestCountryCode(c.country_code, c.operator || rangeName) || 'XX';
    if (rowCc !== cc) continue;
    const r = claim.run(c.id);
    if (r.changes === 1) won.push(c);
  }
  return won;
}

// ---------- Active assignment helper (re-display existing if user already has live numbers) ----------
function getActiveAssignments(tgUserId) {
  return db.prepare(`
    SELECT * FROM tg_assignments
    WHERE tg_user_id = ? AND status IN ('active','otp_received') AND expires_at > ?
    ORDER BY assigned_at DESC
  `).all(tgUserId, now());
}

// ---------- Render ONE compact card listing all numbers in a batch ----------
function renderBatchCard(assignments) {
  if (!assignments || assignments.length === 0) return '📭 No numbers.';
  const live = assignments.filter(a => a.status !== 'released');
  const head = live[0] || assignments[0];
  const cc = bestCountryCode(head.country_code, head.range_name);
  const flag = flagOf(cc);
  const cName = countryName(cc);
  const svc = head.service ? `${serviceIcon(head.service)} ${head.service}` : '📡 SMS';
  const remaining = Math.max(0, head.expires_at - now());
  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  const timer = `⏱ ${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

  const gotOtps = assignments.filter(a => a.status === 'otp_received' && a.otp_code);
  const copyAll = gotOtps.map(a => `${a.phone_number}|${a.otp_code}`).join('\n');

  let txt =
    `📱 <b>Your Numbers (${assignments.length})</b>\n` +
    `${flag} <b>${escapeHtml(cName)}</b> — ${svc}\n` +
    `${timer} until expiry • Rate: ${fmtBdt(head.rate_bdt)} per OTP\n` +
    `━━━━━━━━━━━━━━━━━━━━\n`;

  assignments.forEach((a, i) => {
    const idx = `${(i + 1).toString().padStart(2, '0')}.`;
    if (a.status === 'otp_received' && a.otp_code) {
      txt += `✅ ${idx} <code>${a.phone_number}|${escapeHtml(a.otp_code)}</code>\n`;
    } else if (a.status === 'expired' || a.status === 'released') {
      txt += `⛔ ${idx} <s>${a.phone_number}</s>\n`;
    } else {
      txt += `⏳ ${idx} <code>${a.phone_number}</code>\n`;
    }
  });

  if (gotOtps.length > 0) {
    txt += `━━━━━━━━━━━━━━━━━━━━\n📋 <b>Copy ALL received (${gotOtps.length}):</b>\n<code>${escapeHtml(copyAll)}</code>`;
  } else {
    txt += `\n<i>Tap any number above to copy. OTPs arrive here automatically.</i>`;
  }
  return txt;
}

function batchKeyboard(batchId, allDone) {
  const rows = [];
  if (!allDone) {
    rows.push([
      Markup.button.callback('🗑 Release Unused', `releaseBatch:${batchId}`),
      Markup.button.callback('🌍 Get More', 'menu:get'),
    ]);
  } else {
    rows.push([Markup.button.callback('🌍 Get Another Batch', 'menu:get')]);
  }
  return Markup.inlineKeyboard(rows);
}

// Fetch batch assignments in stable order
function getBatchAssignments(batchId) {
  return db.prepare(`SELECT * FROM tg_assignments WHERE batch_id = ? ORDER BY id ASC`).all(batchId);
}

// ---------- Legacy single-card render (used by My Numbers list) ----------
function renderNumberCard(a) {
  const cc = bestCountryCode(a.country_code, a.range_name);
  const flag = flagOf(cc);
  const cName = countryName(cc);
  const svc = a.service ? `${serviceIcon(a.service)} ${a.service}` : '📡 SMS';
  const remaining = Math.max(0, a.expires_at - now());
  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  const timer = `⏱ ${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  if (a.status === 'otp_received' && a.otp_code) {
    return (
      `✅ ${flag} ${escapeHtml(cName)} — ${svc}\n` +
      `📋 <code>${a.phone_number}|${escapeHtml(a.otp_code)}</code>\n` +
      `<i>${fmtAgo(a.otp_received_at)}</i>`
    );
  }
  return (
    `📱 ${flag} ${escapeHtml(cName)} — ${svc}\n` +
    `📋 <code>${a.phone_number}</code>\n` +
    `${timer} until expiry`
  );
}

function numberCardKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback('🌍 Get Number', 'menu:get')]]);
}

// ============================================================
// COMMANDS / HANDLERS
// ============================================================

bot.start(async (ctx) => {
  const u = ensureTgUser(ctx);
  if (!u) return;
  if (isBanned(u)) return ctx.reply('🚫 You have been banned from using this bot.');
  // Check existing active assignments — re-show them
  const active = getActiveAssignments(u.tg_user_id);
  if (active.length > 0) {
    await ctx.replyWithHTML(welcomeText(u), mainMenuKeyboard());
    await ctx.replyWithHTML(
      `📌 You have <b>${active.length}</b> active number(s) still valid. Tap "📞 My Numbers" to view, or get more below.`
    );
  } else {
    await ctx.replyWithHTML(welcomeText(u), mainMenuKeyboard());
  }
});

// ----- Main menu buttons (text triggers) -----
bot.hears('🌍 Get Number', async (ctx) => {
  const u = ensureTgUser(ctx); if (isBanned(u)) return;
  await showCountries(ctx);
});

bot.hears('📞 My Numbers', async (ctx) => {
  const u = ensureTgUser(ctx); if (isBanned(u)) return;
  await showMyNumbers(ctx);
});

bot.hears('📥 OTP History', async (ctx) => {
  const u = ensureTgUser(ctx); if (isBanned(u)) return;
  await showOtpHistory(ctx);
});

bot.hears('🏆 Leaderboard', async (ctx) => {
  const u = ensureTgUser(ctx); if (isBanned(u)) return;
  await showLeaderboard(ctx);
});

bot.hears('💰 Wallet', async (ctx) => {
  const u = ensureTgUser(ctx); if (isBanned(u)) return;
  await showWallet(ctx);
});

bot.hears('ℹ️ Support', async (ctx) => {
  ensureTgUser(ctx);
  await ctx.replyWithHTML(
    `<b>ℹ️ Support</b>\n\n` +
    `📞 For help, contact our admin team.\n` +
    `🌐 Website: ${SITE_URL}\n\n` +
    `Bot version: 1.0`
  );
});

// ============================================================
// GET NUMBER FLOW
// ============================================================

async function showCountries(ctx) {
  const list = listCountries();
  if (list.length === 0) {
    return ctx.replyWithHTML('😕 <b>No numbers available right now.</b>\nPlease check back in a few minutes.');
  }
  const buttons = list.map(c => [
    Markup.button.callback(`${flagOf(c.code)} ${countryName(c.code)} — ${c.cnt}`, `country:${c.code}`)
  ]);
  await ctx.replyWithHTML(
    `<b>🌍 Available Countries</b>\nPick a country to see ranges:`,
    Markup.inlineKeyboard(buttons)
  );
}

bot.action(/^country:(\w+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const cc = ctx.match[1];
  const ranges = listRangesForCountry(cc);
  if (ranges.length === 0) {
    return ctx.editMessageText(`😕 No ranges available for ${countryName(cc)} right now.`);
  }
  const buttons = ranges.map(r => [
    Markup.button.callback(
      `${serviceIcon(r.service)} ${r.range_name} — ${r.cnt} • ${fmtBdt(r.tg_rate_bdt)}`,
      `range:${r.provider}:${encodeURIComponent(r.range_name)}:${cc}`
    ),
  ]);
  buttons.push([Markup.button.callback('« Back to countries', 'menu:get')]);
  await ctx.editMessageText(
    `${flagOf(cc)} <b>${countryName(cc)}</b>\nPick a service/range:`,
    { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard(buttons).reply_markup }
  );
});

bot.action('menu:get', async (ctx) => {
  await ctx.answerCbQuery();
  await showCountries(ctx);
});
bot.action('menu:mine', async (ctx) => {
  await ctx.answerCbQuery();
  await showMyNumbers(ctx);
});

bot.action(/^range:([^:]+):([^:]+):(\w+)$/, async (ctx) => {
  await ctx.answerCbQuery('Claiming numbers…');
  const provider = ctx.match[1];
  const rangeName = decodeURIComponent(ctx.match[2]);
  const cc = ctx.match[3];

  const u = ensureTgUser(ctx); if (isBanned(u)) return;

  // Wallet check
  const setting = db.prepare(
    'SELECT tg_rate_bdt, service FROM range_tg_settings WHERE provider = ? AND range_name = ? AND tg_enabled = 1'
  ).get(provider, rangeName);
  if (!setting) return ctx.reply('❌ This range is no longer available.');
  const rate = setting.tg_rate_bdt || 0;

  // We reserve = 1 OTP success worth × batch (refunded if no OTP).
  // For simplicity charge only on OTP arrival, but block if balance < rate.
  if (rate > 0 && u.balance_bdt < rate) {
    return ctx.replyWithHTML(
      `💸 <b>Insufficient balance.</b>\nYour balance: ${fmtBdt(u.balance_bdt)}\n` +
      `Each OTP costs: ${fmtBdt(rate)}\nContact admin to top up.`
    );
  }

  const claimed = claimBatch(provider, rangeName, cc, NUMBERS_PER_BATCH);
  if (claimed.length === 0) {
    return ctx.reply('⚠️ No numbers available right now in this range. Try another.');
  }

  const expiresAt = now() + EXPIRY_SEC;
  const batchId = newBatchId();
  const insAssign = db.prepare(`
    INSERT INTO tg_assignments
    (tg_user_id, allocation_id, provider, phone_number, country_code, range_name, service, rate_bdt, status, expires_at, batch_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `);
  const updAlloc = db.prepare("UPDATE allocations SET status='active' WHERE id = ?");

  const createdIds = [];
  for (const c of claimed) {
    const r = insAssign.run(
      u.tg_user_id, c.id, provider, c.phone_number, c.country_code || cc,
      rangeName, setting.service || null, rate, expiresAt, batchId
    );
    updAlloc.run(c.id);
    createdIds.push(r.lastInsertRowid);
  }

  // Render ONE compact card with all numbers
  const assignments = getBatchAssignments(batchId);
  const sent = await ctx.replyWithHTML(renderBatchCard(assignments), batchKeyboard(batchId, false));
  // Save chat+message id on every row so the poller can edit this one card
  db.prepare('UPDATE tg_assignments SET tg_message_id = ?, tg_chat_id = ? WHERE batch_id = ?')
    .run(sent.message_id, sent.chat.id, batchId);
});

// ----- Batch release (new) -----
bot.action(/^releaseBatch:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Releasing unused…');
  const batchId = ctx.match[1];
  const u = ensureTgUser(ctx);
  const rows = db.prepare(`SELECT * FROM tg_assignments WHERE batch_id = ? AND tg_user_id = ?`).all(batchId, u.tg_user_id);
  if (rows.length === 0) return;
  db.transaction(() => {
    for (const a of rows) {
      if (a.status === 'active') {
        db.prepare("UPDATE tg_assignments SET status='released' WHERE id = ?").run(a.id);
        db.prepare("UPDATE allocations SET status='pool' WHERE id = ? AND status='active'").run(a.allocation_id);
      }
    }
  })();
  const fresh = getBatchAssignments(batchId);
  const allDone = !fresh.some(a => a.status === 'active');
  try {
    await ctx.editMessageText(renderBatchCard(fresh), {
      parse_mode: 'HTML',
      reply_markup: batchKeyboard(batchId, allDone).reply_markup,
    });
  } catch {}
});

// ----- Legacy release/change (kept for old one-card assignments) -----
bot.action(/^release:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = +ctx.match[1];
  const u = ensureTgUser(ctx);
  const a = db.prepare('SELECT * FROM tg_assignments WHERE id = ? AND tg_user_id = ?').get(id, u.tg_user_id);
  if (!a || a.status !== 'active') return ctx.reply('Already gone.');
  db.transaction(() => {
    db.prepare("UPDATE tg_assignments SET status='released' WHERE id = ?").run(id);
    db.prepare("UPDATE allocations SET status='pool' WHERE id = ? AND status='active'").run(a.allocation_id);
  })();
  try { await ctx.editMessageText('🗑 Released. Number returned to pool.'); } catch {}
});

// ============================================================
// MY NUMBERS, HISTORY, LEADERBOARD, WALLET
// ============================================================

async function showMyNumbers(ctx) {
  const u = ensureTgUser(ctx);
  const active = getActiveAssignments(u.tg_user_id);
  if (active.length === 0) {
    return ctx.replyWithHTML('📭 No active numbers. Tap 🌍 Get Number.');
  }
  await ctx.replyWithHTML(`<b>📞 Your Active Numbers (${active.length})</b>`);
  for (const a of active) {
    await ctx.replyWithHTML(renderNumberCard(a), numberCardKeyboard(a.id, a.status === 'otp_received'));
  }
}

async function showOtpHistory(ctx) {
  const u = ensureTgUser(ctx);
  const rows = db.prepare(`
    SELECT phone_number, country_code, service, otp_code, otp_received_at
    FROM tg_assignments
    WHERE tg_user_id = ? AND status = 'otp_received' AND otp_code IS NOT NULL
    ORDER BY otp_received_at DESC LIMIT 15
  `).all(u.tg_user_id);
  if (rows.length === 0) return ctx.replyWithHTML('📭 No OTP history yet.');
  let txt = `<b>📥 Your Recent OTPs (${rows.length})</b>\n\n`;
  for (const r of rows) {
    txt += `${flagOf(r.country_code)} ${serviceIcon(r.service)} <code>${r.phone_number}|${escapeHtml(r.otp_code)}</code>\n`;
    txt += `<i>${fmtAgo(r.otp_received_at)}</i>\n\n`;
  }
  await ctx.replyWithHTML(txt);
}

async function showLeaderboard(ctx) {
  const since = now() - 86400;
  const topCountries = db.prepare(`
    SELECT country_code, COUNT(*) cnt FROM tg_assignments
    WHERE status = 'otp_received' AND otp_received_at >= ?
    GROUP BY country_code ORDER BY cnt DESC LIMIT 5
  `).all(since);
  const topRanges = db.prepare(`
    SELECT country_code, range_name, service, COUNT(*) cnt FROM tg_assignments
    WHERE status = 'otp_received' AND otp_received_at >= ?
    GROUP BY country_code, range_name ORDER BY cnt DESC LIMIT 5
  `).all(since);
  let txt = `<b>🏆 Leaderboard (last 24h)</b>\n\n<b>🌍 Top Countries</b>\n`;
  if (topCountries.length === 0) txt += '<i>No data yet</i>\n';
  else topCountries.forEach((r, i) => {
    txt += `${i + 1}. ${flagOf(r.country_code)} ${countryName(r.country_code)} — <b>${r.cnt}</b> OTPs\n`;
  });
  txt += `\n<b>📊 Top Ranges</b>\n`;
  if (topRanges.length === 0) txt += '<i>No data yet</i>\n';
  else topRanges.forEach((r, i) => {
    txt += `${i + 1}. ${flagOf(r.country_code)} ${serviceIcon(r.service)} ${escapeHtml(r.range_name)} — <b>${r.cnt}</b>\n`;
  });
  await ctx.replyWithHTML(txt);
}

async function showWallet(ctx) {
  const u = ensureTgUser(ctx);
  const fresh = db.prepare('SELECT * FROM tg_users WHERE tg_user_id = ?').get(u.tg_user_id);
  const txs = db.prepare(`
    SELECT amount_bdt, type, note, created_at FROM tg_wallet_tx
    WHERE tg_user_id = ? ORDER BY created_at DESC LIMIT 8
  `).all(u.tg_user_id);
  let txt =
    `<b>💰 Your Wallet</b>\n\n` +
    `Balance: <b>${fmtBdt(fresh.balance_bdt)}</b>\n` +
    `Total OTPs: <b>${fresh.total_otps}</b>\n` +
    `Total Spent: <b>${fmtBdt(fresh.total_spent)}</b>\n\n` +
    `<b>Recent Transactions</b>\n`;
  if (txs.length === 0) txt += '<i>None yet — contact admin to top up.</i>';
  else for (const t of txs) {
    const sign = t.amount_bdt >= 0 ? '➕' : '➖';
    txt += `${sign} ${fmtBdt(Math.abs(t.amount_bdt))} <i>${t.type}</i> — ${fmtAgo(t.created_at)}\n`;
  }
  await ctx.replyWithHTML(txt);
}

// ============================================================
// OTP DELIVERY POLLER — watches allocations.otp + emits to TG
// ============================================================

let lastOtpScanAt = now();

async function pollOtps() {
  try {
    // Find allocations that received OTP since last scan AND have an active TG assignment
    const candidates = db.prepare(`
      SELECT t.id AS assignment_id, t.tg_user_id, t.tg_chat_id, t.tg_message_id,
             t.phone_number, t.country_code, t.service, t.range_name, t.rate_bdt,
             t.expires_at, a.otp, a.cli, a.otp_received_at
      FROM tg_assignments t
      JOIN allocations a ON a.id = t.allocation_id
      WHERE t.status = 'active'
        AND a.otp IS NOT NULL AND a.otp != ''
        AND (a.otp_received_at IS NULL OR a.otp_received_at >= ?)
    `).all(lastOtpScanAt - 5);
    lastOtpScanAt = now();

    for (const c of candidates) {
      // mark assignment as otp_received + bill the user (if rate > 0)
      const updated = db.prepare(`
        UPDATE tg_assignments
        SET status = 'otp_received', otp_code = ?, otp_full_text = ?, otp_received_at = ?
        WHERE id = ? AND status = 'active'
      `).run(c.otp, c.cli || c.otp, c.otp_received_at || now(), c.assignment_id);
      if (updated.changes !== 1) continue;

      // bill
      if (c.rate_bdt > 0) {
        db.transaction(() => {
          db.prepare('UPDATE tg_users SET balance_bdt = balance_bdt - ?, total_otps = total_otps + 1, total_spent = total_spent + ? WHERE tg_user_id = ?')
            .run(c.rate_bdt, c.rate_bdt, c.tg_user_id);
          db.prepare('INSERT INTO tg_wallet_tx (tg_user_id, amount_bdt, type, ref_id, note) VALUES (?, ?, ?, ?, ?)')
            .run(c.tg_user_id, -c.rate_bdt, 'deduct', c.assignment_id, `OTP success ${c.phone_number}`);
        })();
      } else {
        db.prepare('UPDATE tg_users SET total_otps = total_otps + 1 WHERE tg_user_id = ?').run(c.tg_user_id);
      }

      // edit existing card → OTP card
      const card = {
        phone_number: c.phone_number,
        country_code: c.country_code,
        service: c.service,
        otp_code: c.otp,
        otp_full_text: c.cli || c.otp,
        rate_bdt: c.rate_bdt,
        expires_at: c.expires_at,
        status: 'otp_received',
      };
      try {
        if (c.tg_chat_id && c.tg_message_id) {
          await bot.telegram.editMessageText(
            c.tg_chat_id, c.tg_message_id, undefined, renderNumberCard(card),
            { parse_mode: 'HTML', reply_markup: numberCardKeyboard(c.assignment_id, true).reply_markup }
          );
        }
      } catch (e) {
        console.warn('[tgbot] edit fail, sending new', e.message);
        await bot.telegram.sendMessage(c.tg_chat_id, renderNumberCard(card), {
          parse_mode: 'HTML', reply_markup: numberCardKeyboard(c.assignment_id, true).reply_markup,
        });
      }
      // Always also send a clean standalone OTP card for easy copy
      try {
        await bot.telegram.sendMessage(c.tg_chat_id,
          `🎉 <b>OTP arrived!</b>\n\n📋 <code>${c.phone_number}|${escapeHtml(c.otp)}</code>`,
          { parse_mode: 'HTML' }
        );
      } catch {}
      console.log(`[tgbot] OTP delivered → tg=${c.tg_user_id} num=${c.phone_number} otp=${c.otp}`);
    }
  } catch (e) {
    console.error('[tgbot] pollOtps error:', e.message);
  }
}

// ============================================================
// EXPIRY JANITOR — return unused numbers to pool every 60s
// ============================================================
function expireOldAssignments() {
  try {
    const expired = db.prepare(`
      SELECT id, allocation_id FROM tg_assignments
      WHERE status = 'active' AND expires_at < ?
    `).all(now());
    if (expired.length === 0) return;
    const txn = db.transaction(() => {
      for (const e of expired) {
        db.prepare("UPDATE tg_assignments SET status='expired' WHERE id = ?").run(e.id);
        db.prepare("UPDATE allocations SET status='pool' WHERE id = ? AND status='active'").run(e.allocation_id);
      }
    });
    txn();
    console.log(`[tgbot] expired ${expired.length} unused number(s) → returned to pool`);
  } catch (e) {
    console.error('[tgbot] expire error:', e.message);
  }
}

// ============================================================
// BROADCAST WORKER — picks up pending broadcasts from admin UI
// ============================================================
async function processBroadcasts() {
  const pending = db.prepare("SELECT * FROM tg_broadcasts WHERE status = 'pending' ORDER BY id ASC LIMIT 1").get();
  if (!pending) return;
  db.prepare("UPDATE tg_broadcasts SET status='sending' WHERE id = ?").run(pending.id);
  const users = db.prepare("SELECT tg_user_id FROM tg_users WHERE status = 'active'").all();
  let sent = 0, failed = 0;
  for (const u of users) {
    try {
      await bot.telegram.sendMessage(u.tg_user_id, pending.message, { parse_mode: pending.parse_mode || 'HTML' });
      sent++;
      // 30 msg/sec rate limit
      await new Promise(r => setTimeout(r, 35));
    } catch (e) {
      failed++;
      // If user blocked the bot, mark them inactive
      if (e.code === 403) {
        db.prepare("UPDATE tg_users SET status='banned' WHERE tg_user_id = ?").run(u.tg_user_id);
      }
    }
  }
  db.prepare("UPDATE tg_broadcasts SET status='done', sent_count=?, failed_count=?, finished_at=? WHERE id = ?")
    .run(sent, failed, now(), pending.id);
  console.log(`[tgbot] broadcast #${pending.id} done: sent=${sent} failed=${failed}`);
}

// ============================================================
// LAUNCH
// ============================================================
bot.catch((err, ctx) => {
  console.error(`[tgbot] error for ${ctx.updateType}:`, err);
});

(async () => {
  try {
    // Make sure no webhook is set (we use polling)
    await bot.telegram.deleteWebhook({ drop_pending_updates: false }).catch(() => {});
    const me = await bot.telegram.getMe();
    console.log(`✓ NEXUS X tgbot launching as @${me.username} (${me.id})`);
    bot.launch({ dropPendingUpdates: false });
    setInterval(pollOtps, 4000);
    setInterval(expireOldAssignments, 60_000);
    setInterval(processBroadcasts, 5_000);
    console.log('✓ OTP poller (4s) + expiry janitor (60s) + broadcast worker (5s) started');
  } catch (e) {
    console.error('FATAL: bot launch failed:', e.message);
    process.exit(1);
  }
})();

process.once('SIGINT',  () => { console.log('SIGINT — stopping bot'); bot.stop('SIGINT'); });
process.once('SIGTERM', () => { console.log('SIGTERM — stopping bot'); bot.stop('SIGTERM'); });
