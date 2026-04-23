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

// Confirmed custom_emoji_id values, captured from the reference OTP feed channel.
// Add more entries here as you forward more sample messages.
const FLAG_EMOJI_IDS = Object.freeze({
  TN: '5221991375016310330', // Tunisia
  IQ: '5221980268230882832', // Iraq
  KE: '5222089648163009103', // Kenya
  // ── add new IDs below this line ──
});

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