// Telegram PREMIUM custom emoji IDs for country flags.
//
// HOW THIS WORKS
// ──────────────
// Telegram lets bots send "custom emoji" inside <tg-emoji emoji-id="..."> tags.
// Each country flag in the public flag pack has its own unique numeric ID.
// Premium users see the full-color/animated flag; everyone else automatically
// sees the unicode fallback (🇧🇩 🇺🇸 etc) — no errors, no missing flags.
//
// HOW TO ADD A NEW FLAG ID
// ────────────────────────
// 1. In a Telegram chat with @RawDataBot, forward an OTP message that contains
//    the country flag custom emoji you want to capture.
// 2. In the JSON dump, find the entity with type="custom_emoji" at the position
//    of the flag, copy its `custom_emoji_id`.
// 3. Paste into FLAG_EMOJI_IDS below using the ISO-3166 alpha-2 country code as
//    the key. That's it — the bot picks it up next restart.
//
// Unknown / not-yet-mapped countries automatically get the unicode flag, so it's
// always safe to leave entries missing.

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Auto-loaded flag IDs. The bot calls `loadFlagPack(bot, packName)` at startup
// with a Telegram sticker-set name (e.g. "FlagsByKoylli"). Every sticker in the
// pack has both a `custom_emoji_id` and an `emoji` field — we walk the unicode
// flag glyph back to its ISO-3166 alpha-2 country code and store it here.
//
// Manual entries take precedence over auto-loaded IDs (so you can override or
// pre-seed with confirmed IDs even before first launch).
// ─────────────────────────────────────────────────────────────────────────────

// Pre-seeded confirmed IDs from forwarded message dumps.
const MANUAL_FLAG_IDS = {
  TN: '5221991375016310330', // Tunisia
  IQ: '5221980268230882832', // Iraq
  KE: '5222089648163009103', // Kenya
};

// Mutable map populated at startup (manual + auto-loaded). Read with getFlagEmoji().
const FLAG_EMOJI_IDS = { ...MANUAL_FLAG_IDS };

// Convert a unicode flag glyph (e.g. 🇧🇩) back to its ISO-3166 alpha-2 code.
// Returns null if the input is not a valid regional-indicator flag pair.
function flagGlyphToCC(glyph) {
  if (!glyph || typeof glyph !== 'string') return null;
  const codepoints = Array.from(glyph).map((c) => c.codePointAt(0) || 0);
  if (codepoints.length !== 2) return null;
  const A = 0x1f1e6;
  const Z = 0x1f1ff;
  if (codepoints[0] < A || codepoints[0] > Z) return null;
  if (codepoints[1] < A || codepoints[1] > Z) return null;
  return String.fromCharCode(65 + (codepoints[0] - A), 65 + (codepoints[1] - A));
}

/**
 * Load a Telegram custom-emoji sticker pack and register every flag in it.
 * `bot` is a Telegraf instance (uses bot.telegram.getStickerSet under the hood).
 * Returns the number of flag IDs registered.
 */
async function loadFlagPack(bot, packName) {
  if (!bot || !packName) return 0;
  try {
    const set = await bot.telegram.getStickerSet(packName);
    let added = 0;
    for (const st of set.stickers || []) {
      const id = st.custom_emoji_id || (st.thumbnail && st.thumbnail.file_id);
      const cc = flagGlyphToCC(st.emoji);
      if (!id || !cc) continue;
      // Manual entries always win — they're confirmed by hand.
      if (MANUAL_FLAG_IDS[cc]) continue;
      if (!FLAG_EMOJI_IDS[cc]) {
        FLAG_EMOJI_IDS[cc] = String(id);
        added++;
      }
    }
    return added;
  } catch (e) {
    console.warn(`[flagEmojiMap] failed to load pack "${packName}": ${e.message}`);
    return 0;
  }
}

// Convert an ISO-3166 alpha-2 country code into its unicode flag emoji
// (regional-indicator pair). Always works in any Telegram client.
function unicodeFlag(cc) {
  if (!cc || typeof cc !== 'string' || cc.length !== 2) return '';
  const code = cc.toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return '';
  const A = 0x1f1e6 - 65; // 🇦 = U+1F1E6
  return String.fromCodePoint(A + code.charCodeAt(0), A + code.charCodeAt(1));
}

/**
 * Get the best flag representation for a country code.
 * Returns an object: { id, fallback } when a custom emoji ID exists, or
 * { id: null, fallback } when only the unicode flag is available.
 * Caller can render `<tg-emoji emoji-id="${id}">${fallback}</tg-emoji>` if id
 * is set, otherwise just emit `fallback` directly.
 */
function getFlagEmoji(cc) {
  const code = String(cc || '').toUpperCase();
  const fallback = unicodeFlag(code) || '🏳️';
  const id = FLAG_EMOJI_IDS[code] || null;
  return { id, fallback };
}

/**
 * Render a country flag as a Telegram HTML snippet — uses custom emoji when
 * available, falls back to the plain unicode flag otherwise. Safe to embed
 * directly inside parse_mode='HTML' messages.
 */
function renderFlagHtml(cc) {
  const { id, fallback } = getFlagEmoji(cc);
  if (id) return `<tg-emoji emoji-id="${id}">${fallback}</tg-emoji>`;
  return fallback;
}

module.exports = { FLAG_EMOJI_IDS, unicodeFlag, getFlagEmoji, renderFlagHtml };