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
    let n = String(v).trim();
    if (!n) return null;
    // Accept @username, plain username, https://t.me/username, or numeric -100… chat id
    if (n.startsWith('https://t.me/')) n = n.replace('https://t.me/', '');
    if (n.startsWith('http://t.me/')) n = n.replace('http://t.me/', '');
    if (/^-?\d+$/.test(n)) return n;            // numeric chat id
    if (n.startsWith('@')) return n;            // @channelusername
    if (n.startsWith('+')) return null;         // private invite hash — needs numeric id, can't post
    return '@' + n;                             // bare username → prepend @
  } catch { return null; }
}

function getBotConfig() {
  try {
    const rows = db.prepare(`
      SELECT key, value FROM settings
      WHERE key IN ('tg_public_channel', 'tg_required_group', 'tg_required_otp_group', 'tg_terms_text')
    `).all();
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return {
      publicChannel: map.tg_public_channel || '@nexusxotpgroup',
      requiredGroup: map.tg_required_group || 'https://t.me/nexusxotpgroup',
      requiredGroupChat: map.tg_required_group_chat || '@nexusxotpgroup',
      otpGroup: map.tg_required_otp_group || 'https://t.me/+6RUOKrkz6YU1Yjk1',
      otpGroupChat: map.tg_required_otp_group_chat || '',
      terms: map.tg_terms_text || 'By using this bot you agree to follow our rules, keep OTP data private, and use numbers responsibly.',
    };
  } catch {
    return {
      publicChannel: '@nexusxotpgroup',
      requiredGroup: 'https://t.me/nexusxotpgroup',
      requiredGroupChat: '@nexusxotpgroup',
      otpGroup: 'https://t.me/+6RUOKrkz6YU1Yjk1',
      otpGroupChat: '',
      terms: 'By using this bot you agree to follow our rules, keep OTP data private, and use numbers responsibly.',
    };
  }
}

// Seed the public channel on boot if admin hasn't set it yet — so fake-OTP works out of the box
function seedDefaults() {
  try {
    const stmt = db.prepare(`INSERT OR IGNORE INTO settings (key, value, updated_at)
      VALUES (?, ?, strftime('%s','now'))`);
    stmt.run('tg_public_channel', '@nexusxotpgroup');
    stmt.run('tg_required_group', 'https://t.me/nexusxotpgroup');
    stmt.run('tg_required_group_chat', '@nexusxotpgroup');
  } catch (e) { console.warn('[seedDefaults]', e.message); }
}
seedDefaults();

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
    ['📥 OTP History', '🔍 Active Range Checker'],
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

function firstTimeWelcomeText(u) {
  const cfg = getBotConfig();
  const nm = u.first_name || u.username || 'friend';
  return (
    `╔══════════════════════════╗\n` +
    `   ✨ <b>NEXUS X — OTP Bot</b> ✨\n` +
    `╚══════════════════════════╝\n\n` +
    `👋 <b>Hey ${escapeHtml(nm)}!</b>\n` +
    `Welcome to the fastest OTP delivery network 🚀\n\n` +
    `🎁 <b>What you get:</b>\n` +
    `  ⚡ Instant numbers — 50+ countries\n` +
    `  🔐 Real-time OTPs in this chat\n` +
    `  💎 Wallet-based, no surprises\n` +
    `  📊 Live public OTP feed\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🚪 <b>One-time setup</b>\n` +
    `Tap the buttons below to join <b>both</b> groups, then press ✅\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📜 <b>Terms of Use</b>\n<i>${escapeHtml(cfg.terms)}</i>`
  );
}

function onboardingKeyboard() {
  const cfg = getBotConfig();
  return Markup.inlineKeyboard([
    [Markup.button.url('📣 Join Public Channel', cfg.requiredGroup)],
    [Markup.button.url('📥 Join OTP History Group', cfg.otpGroup)],
    [Markup.button.callback('✅ I Joined & Accept Terms', 'onboard:accept')],
    [Markup.button.callback('🔄 Check Again', 'onboard:check')],
  ]);
}

function isOnboarded(tgUserId) {
  try {
    const note = db.prepare('SELECT notes FROM tg_users WHERE tg_user_id = ?').get(tgUserId)?.notes || '';
    return /onboarded=true/.test(String(note));
  } catch {
    return false;
  }
}

function markOnboarded(tgUserId) {
  const current = db.prepare('SELECT notes FROM tg_users WHERE tg_user_id = ?').get(tgUserId)?.notes || '';
  const cleaned = String(current).replace(/\bonboarded=true\b/g, '').trim();
  const next = [cleaned, 'onboarded=true'].filter(Boolean).join(' | ');
  db.prepare('UPDATE tg_users SET notes = ? WHERE tg_user_id = ?').run(next, tgUserId);
}

async function verifyRequiredMembership(ctx) {
  const cfg = getBotConfig();
  const checks = [
    { chatId: cfg.requiredGroupChat, label: 'public group' },
    { chatId: cfg.otpGroupChat, label: 'OTP history group' },
  ].filter((x) => x.chatId);
  if (checks.length === 0) return true;
  for (const check of checks) {
    try {
      const member = await bot.telegram.getChatMember(check.chatId, ctx.from.id);
      if (!['creator', 'administrator', 'member'].includes(member.status)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function ensureBotReady(ctx, tgUser) {
  if (isBanned(tgUser)) {
    await ctx.reply('🚫 You have been banned from using this bot.');
    return false;
  }
  if (!isOnboarded(tgUser.tg_user_id)) {
    await ctx.replyWithHTML(firstTimeWelcomeText(tgUser), onboardingKeyboard());
    return false;
  }
  return true;
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
// Per-provider range_meta tables (from admin RangePoolGrid) — used to honor
// the new "disabled" toggle so admin-hidden ranges are skipped here too.
const RANGE_META_TABLES = {
  numpanel: 'numpanel_range_meta',
  ims: 'ims_range_meta',
  msi: 'msi_range_meta',
  iprn: 'iprn_range_meta',
  iprn_sms: 'iprn_sms_range_meta',
};

// Returns Set of "provider::range_name" that admin has disabled.
function getDisabledRangeKeys() {
  const disabled = new Set();
  for (const [provider, table] of Object.entries(RANGE_META_TABLES)) {
    try {
      const rows = db.prepare(
        `SELECT range_prefix FROM ${table} WHERE COALESCE(disabled, 0) = 1`
      ).all();
      for (const r of rows) disabled.add(`${provider}::${r.range_prefix}`);
    } catch {
      // Table may not exist yet for a provider that hasn't booted — ignore.
    }
  }
  return disabled;
}

function listCountries() {
  const rows = db.prepare(`
    SELECT a.country_code AS raw_cc, COALESCE(a.operator,'Unknown') AS range_name, COUNT(*) AS cnt
         , a.provider AS provider
    FROM allocations a
    JOIN range_tg_settings r
      ON r.provider = a.provider
     AND r.range_name = COALESCE(a.operator, 'Unknown')
    WHERE a.status = 'pool' AND r.tg_enabled = 1
    GROUP BY a.provider, a.country_code, range_name
  `).all();
  const disabled = getDisabledRangeKeys();
  const agg = new Map();
  for (const r of rows) {
    if (disabled.has(`${r.provider}::${r.range_name}`)) continue;
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
  const disabled = getDisabledRangeKeys();
  return rows
    .filter(r => !disabled.has(`${r.provider}::${r.range_name}`))
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
  if (!(await ensureBotReady(ctx, u))) return;
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

bot.action('onboard:check', async (ctx) => {
  await ctx.answerCbQuery();
  const u = ensureTgUser(ctx);
  if (!u || isOnboarded(u.tg_user_id)) return ctx.replyWithHTML(welcomeText(u), mainMenuKeyboard());
  await ctx.replyWithHTML(firstTimeWelcomeText(u), onboardingKeyboard());
});

bot.action('onboard:accept', async (ctx) => {
  await ctx.answerCbQuery();
  const u = ensureTgUser(ctx);
  if (!u) return;
  const verified = await verifyRequiredMembership(ctx);
  if (!verified) {
    return ctx.replyWithHTML('⚠️ <b>Join verification failed.</b>\nPlease join both required groups first, then tap verify again.', onboardingKeyboard());
  }
  markOnboarded(u.tg_user_id);
  await ctx.replyWithHTML(`✅ <b>Verification complete.</b>\nYou can use the bot now.`, mainMenuKeyboard());
});

// ----- Main menu buttons (text triggers) -----
bot.hears('🌍 Get Number', async (ctx) => {
  const u = ensureTgUser(ctx); if (!u || !(await ensureBotReady(ctx, u))) return;
  await showCountries(ctx);
});

bot.hears('📞 My Numbers', async (ctx) => {
  const u = ensureTgUser(ctx); if (!u || !(await ensureBotReady(ctx, u))) return;
  await showMyNumbers(ctx);
});

bot.hears('📥 OTP History', async (ctx) => {
  const u = ensureTgUser(ctx); if (!u || !(await ensureBotReady(ctx, u))) return;
  await showOtpHistory(ctx);
});

bot.hears('🔍 Active Range Checker', async (ctx) => {
  const u = ensureTgUser(ctx); if (!u || !(await ensureBotReady(ctx, u))) return;
  await showLeaderboard(ctx);
});
// Legacy label fallback for older keyboards
bot.hears('🏆 Leaderboard', async (ctx) => {
  const u = ensureTgUser(ctx); if (!u || !(await ensureBotReady(ctx, u))) return;
  await showLeaderboard(ctx);
});

bot.hears('💰 Wallet', async (ctx) => {
  const u = ensureTgUser(ctx); if (!u || !(await ensureBotReady(ctx, u))) return;
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

  const u = ensureTgUser(ctx); if (!u || !(await ensureBotReady(ctx, u))) return;

  // Wallet check
  const setting = db.prepare(
    'SELECT tg_rate_bdt, service FROM range_tg_settings WHERE provider = ? AND range_name = ? AND tg_enabled = 1'
  ).get(provider, rangeName);
  if (!setting) return ctx.reply('❌ This range is no longer available.');
  // Honor admin "Hide from agents" toggle from the new RangePoolGrid.
  if (getDisabledRangeKeys().has(`${provider}::${rangeName}`)) {
    return ctx.reply('🚫 This range was just disabled by admin. Please pick another.');
  }
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
  // FIX: also reset allocated_at so the OTP-poller cleanup cron doesn't
  // instantly mark a freshly-claimed pool number as 'expired' just because
  // its row was sitting in pool with an old allocated_at timestamp.
  const updAlloc = db.prepare(
    "UPDATE allocations SET status='active', user_id=?, allocated_at=strftime('%s','now') WHERE id = ?"
  );

  const createdIds = [];
  for (const c of claimed) {
    const r = insAssign.run(
      u.tg_user_id, c.id, provider, c.phone_number, c.country_code || cc,
      rangeName, setting.service || null, rate, expiresAt, batchId
    );
    // Use the bot's system pool user so allocations.user_id stays valid
    // (the actual TG owner is tracked in tg_assignments.tg_user_id).
    updAlloc.run(getOrCreateFakeUserId(), c.id);
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
        // Reset allocated_at so the next claimer (TG or website) gets a clean
        // expiry window — prevents "instant expired" on subsequent grabs.
        db.prepare("UPDATE allocations SET status='pool', allocated_at=strftime('%s','now') WHERE id = ? AND status='active'")
          .run(a.allocation_id);
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
    db.prepare("UPDATE allocations SET status='pool', allocated_at=strftime('%s','now') WHERE id = ? AND status='active'").run(a.allocation_id);
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
  const grouped = new Map();
  for (const row of active) {
    const key = row.batch_id || `single:${row.id}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  await ctx.replyWithHTML(`<b>📞 Your Active Numbers (${active.length})</b>`);
  for (const [key, rows] of grouped.entries()) {
    const allDone = !rows.some(a => a.status === 'active');
    if (String(key).startsWith('single:')) {
      const a = rows[0];
      await ctx.replyWithHTML(renderNumberCard(a), numberCardKeyboard(a.id, a.status === 'otp_received'));
    } else {
      await ctx.replyWithHTML(renderBatchCard(rows), batchKeyboard(key, allDone));
    }
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
  // Pull from CDR — captures BOTH real OTPs (note IS NULL or != fake:broadcast)
  // AND fake-OTP broadcaster rows (note='fake:broadcast'). Counts merge into
  // one number so agents see total range activity (real + boost).
  const topCountries = db.prepare(`
    SELECT country_code, COUNT(*) cnt FROM cdr
    WHERE status = 'billed' AND created_at >= ?
    GROUP BY country_code ORDER BY cnt DESC LIMIT 5
  `).all(since);
  const topRanges = db.prepare(`
    SELECT country_code, operator AS range_name, COUNT(*) cnt FROM cdr
    WHERE status = 'billed' AND created_at >= ?
    GROUP BY country_code, operator ORDER BY cnt DESC LIMIT 8
  `).all(since);
  // Total counter (real + boost combined)
  const totalRow = db.prepare(`
    SELECT COUNT(*) cnt FROM cdr WHERE status='billed' AND created_at >= ?
  `).get(since);
  const total = totalRow?.cnt || 0;

  let txt = `<b>🔍 Active Range Checker (last 24h)</b>\n` +
            `📊 Total OTPs delivered: <b>${total}</b>\n\n` +
            `<b>🌍 Top Countries</b>\n`;
  if (topCountries.length === 0) txt += '<i>No data yet</i>\n';
  else topCountries.forEach((r, i) => {
    txt += `${i + 1}. ${flagOf(r.country_code)} ${countryName(r.country_code)} — <b>${r.cnt}</b> OTPs\n`;
  });
  txt += `\n<b>📊 Top Active Ranges</b>\n`;
  if (topRanges.length === 0) txt += '<i>No data yet</i>\n';
  else topRanges.forEach((r, i) => {
    txt += `${i + 1}. ${flagOf(r.country_code)} ${escapeHtml(r.range_name || '—')} — <b>${r.cnt}</b>\n`;
  });
  txt += `\n<i>Tip: pick a hot range above for higher OTP delivery rates.</i>`;
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

function mirrorOtpToWebsite(c) {
  let sysUser = db.prepare("SELECT id FROM users WHERE username = '__ims_pool__'").get();
  if (!sysUser) {
    const r = db.prepare(`INSERT INTO users (username, password_hash, role, status) VALUES ('__ims_pool__', '!', 'agent', 'suspended')`).run();
    sysUser = { id: r.lastInsertRowid };
  }
  db.prepare(`
    INSERT INTO cdr (user_id, allocation_id, provider, country_code, operator, phone_number, otp_code, cli, price_bdt, status, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'billed', ?)
  `).run(
    sysUser.id,
    c.assignment_id,
    c.provider || 'telegram',
    c.country_code || null,
    c.range_name || null,
    c.phone_number,
    c.otp,
    c.cli || c.service || 'telegram',
    c.rate_bdt || 0,
    `tgbot:${c.tg_user_id}`
  );
}

async function postPublicOtp(c) {
  const chatId = getPublicChannelId();
  if (!chatId) return;
  const maskedNumber = maskLast4(c.phone_number);
  const otpMasked = maskLast4(c.otp);
  const msg =
    `🔥 <b>New OTP Received</b>\n` +
    `📱 <code>${maskedNumber}</code>\n` +
    `🔐 <code>${otpMasked}</code>\n` +
    `${flagOf(c.country_code)} ${escapeHtml(countryName(c.country_code))} • ${serviceIcon(c.service)} ${escapeHtml(c.range_name || c.service || 'OTP')}`;
  await bot.telegram.sendMessage(chatId, msg, { parse_mode: 'HTML' });
}

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

       mirrorOtpToWebsite(c);
       await postPublicOtp(c).catch(() => {});

       const batchId = db.prepare('SELECT batch_id FROM tg_assignments WHERE id = ?').get(c.assignment_id)?.batch_id || null;
       const batchRows = batchId ? getBatchAssignments(batchId) : [];
      try {
        if (c.tg_chat_id && c.tg_message_id) {
           if (batchId && batchRows.length > 0) {
             const allDone = !batchRows.some(a => a.status === 'active');
             await bot.telegram.editMessageText(
               c.tg_chat_id, c.tg_message_id, undefined, renderBatchCard(batchRows),
               { parse_mode: 'HTML', reply_markup: batchKeyboard(batchId, allDone).reply_markup }
             );
           } else {
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
             await bot.telegram.editMessageText(
               c.tg_chat_id, c.tg_message_id, undefined, renderNumberCard(card),
               { parse_mode: 'HTML', reply_markup: numberCardKeyboard(c.assignment_id, true).reply_markup }
             );
           }
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
        db.prepare("UPDATE allocations SET status='pool', allocated_at=strftime('%s','now') WHERE id = ? AND status='active'").run(e.allocation_id);
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
// FAKE OTP BROADCASTER — toggle-driven, samples real numbers (read-only)
// from enabled ranges, generates 5–6 digit OTPs, posts to public TG group
// AND inserts CDR rows tagged 'fake:broadcast' (visible while toggle ON,
// filtered out when OFF — never affects real OTPs / pool).
// ============================================================
function getFakeCfg() {
  const rows = db.prepare(`
    SELECT key, value FROM settings WHERE key IN
    ('fake_otp_enabled','fake_otp_min_sec','fake_otp_max_sec','fake_otp_burst')
  `).all();
  const m = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    enabled: m.fake_otp_enabled === 'true',
    minSec: Math.max(5, +m.fake_otp_min_sec || 20),
    maxSec: Math.max(5, +m.fake_otp_max_sec || 30),
    burst:  Math.max(1, Math.min(10, +m.fake_otp_burst || 2)),
  };
}

function sampleRealPoolNumbers(count) {
  // READ-ONLY sample. Borrows phone+meta from pool without mutating allocations.
  return db.prepare(`
    SELECT a.phone_number, a.country_code, a.operator AS range_name,
           a.provider, r.service, r.tg_rate_bdt
    FROM allocations a
    JOIN range_tg_settings r
      ON r.provider = a.provider
     AND r.range_name = COALESCE(a.operator, 'Unknown')
    WHERE a.status = 'pool' AND r.tg_enabled = 1
    ORDER BY RANDOM()
    LIMIT ?
  `).all(count);
}

function genFakeOtp() {
  const len = Math.random() < 0.5 ? 5 : 6;
  let s = '';
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 10);
  return s;
}

function getOrCreateFakeUserId() {
  let u = db.prepare("SELECT id FROM users WHERE username = '__fake_broadcast__'").get();
  if (!u) {
    const r = db.prepare(`INSERT INTO users (username, password_hash, role, status, full_name)
      VALUES ('__fake_broadcast__', '!', 'agent', 'suspended', 'Fake Broadcast (system)')`).run();
    u = { id: r.lastInsertRowid };
  }
  return u.id;
}

async function fakeOtpBroadcastTick() {
  try {
    const cfg = getFakeCfg();
    if (!cfg.enabled) return;
    const samples = sampleRealPoolNumbers(cfg.burst);
    if (samples.length === 0) return;

    const channelId = getPublicChannelId();
    const sysUser = getOrCreateFakeUserId();
    const insertCdr = db.prepare(`
      INSERT INTO cdr (user_id, allocation_id, provider, country_code, operator,
                       phone_number, otp_code, cli, price_bdt, status, note)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 0, 'billed', 'fake:broadcast')
    `);

    for (const row of samples) {
      const otp = genFakeOtp();
      const cc = bestCountryCode(row.country_code, row.range_name);
      try {
        insertCdr.run(
          sysUser, row.provider || 'fake', cc || row.country_code || null,
          row.range_name || null, row.phone_number, otp,
          row.service || 'OTP'
        );
      } catch (e) { console.warn('[fake-otp] cdr insert fail:', e.message); }

      if (channelId) {
        const masked = maskLast4(row.phone_number);
        const otpMasked = maskLast4(otp);
        try {
          await bot.telegram.sendMessage(channelId,
            `🔥 <b>New OTP Received</b>\n` +
            `📱 <code>${masked}</code>\n` +
            `🔐 <code>${otpMasked}</code>\n` +
            `${flagOf(cc)} ${escapeHtml(countryName(cc))} • ${serviceIcon(row.service)} ${escapeHtml(row.range_name || row.service || 'OTP')}`,
            { parse_mode: 'HTML' }
          );
        } catch (e) {
          console.error(`[fake-otp] tg post FAIL channel=${channelId} err=${e.message} (description=${e.description || '—'}). ` +
            `Hint: bot must be ADMIN of the channel and channel must be public OR you must use the numeric -100… chat id.`);
        }
        await new Promise(r => setTimeout(r, 600));
      } else {
        console.warn('[fake-otp] no public channel configured — set tg_public_channel in settings (e.g. @nexusxotpgroup or -1001234567890)');
      }
    }
    console.log(`[fake-otp] burst sent: ${samples.length} (channel=${channelId || 'NONE'})`);
  } catch (e) {
    console.error('[fake-otp] tick error:', e.message);
  } finally {
    scheduleNextFakeTick();
  }
}

let _fakeTimer = null;
function scheduleNextFakeTick() {
  if (_fakeTimer) clearTimeout(_fakeTimer);
  const cfg = getFakeCfg();
  const delay = cfg.enabled
    ? Math.floor((cfg.minSec + Math.random() * Math.max(0, cfg.maxSec - cfg.minSec)) * 1000)
    : 30_000; // cheap idle poll while disabled
  _fakeTimer = setTimeout(fakeOtpBroadcastTick, delay);
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
    scheduleNextFakeTick();
    console.log('✓ OTP poller (4s) + expiry janitor (60s) + broadcast worker (5s) + fake-OTP broadcaster (toggle) started');
  } catch (e) {
    console.error('FATAL: bot launch failed:', e.message);
    process.exit(1);
  }
})();

process.once('SIGINT',  () => { console.log('SIGINT — stopping bot'); bot.stop('SIGINT'); });
process.once('SIGTERM', () => { console.log('SIGTERM — stopping bot'); bot.stop('SIGTERM'); });
