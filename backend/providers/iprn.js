// IPRN provider — manual pool from iprnBot scraper (iprndata.com)
// Mirrors backend/providers/msi.js exactly, but with provider='iprn' and references iprnBot.
const db = require('../lib/db');

module.exports = {
  id: 'iprn',
  name: 'IPRN Data',
  mode: 'manual',

  async listCountries() {
    return db.prepare(`
      SELECT DISTINCT country_code as code, COALESCE(country_name, country_code) as name
      FROM rates WHERE provider = 'iprn' AND country_code IS NOT NULL
    `).all();
  },

  async listOperators() {
    return db.prepare(`
      SELECT DISTINCT operator as name FROM rates
      WHERE provider = 'iprn' AND operator IS NOT NULL
    `).all();
  },

  // Distinct ranges currently in pool (joined with iprn_range_meta to filter disabled)
  async listRanges() {
    return db.prepare(`
      SELECT
        COALESCE(a.operator, 'Unknown') AS name,
        COUNT(*) AS count
      FROM allocations a
      LEFT JOIN iprn_range_meta m ON m.range_prefix = COALESCE(a.operator, 'Unknown')
      WHERE a.provider = 'iprn' AND a.status = 'pool'
        AND COALESCE(m.disabled, 0) = 0
      GROUP BY COALESCE(a.operator, 'Unknown')
      HAVING count > 0
      ORDER BY name ASC
    `).all();
  },

  // Pull next available number from IPRN pool. Atomic claim like MSI/IMS.
  async getNumber({ range, countryCode, operator } = {}) {
    let iprnBot = null;
    try { iprnBot = require('../workers/iprnBot'); } catch (_) {}

    let q = `SELECT a.id, a.phone_number, a.operator, a.country_code
             FROM allocations a
             LEFT JOIN iprn_range_meta m ON m.range_prefix = COALESCE(a.operator, 'Unknown')
             WHERE a.provider = 'iprn' AND a.status = 'pool'
               AND COALESCE(m.disabled, 0) = 0`;
    const params = [];
    if (range) { q += ' AND COALESCE(a.operator, \'Unknown\') = ?'; params.push(range); }
    else {
      if (countryCode) { q += ' AND a.country_code = ?'; params.push(countryCode); }
      if (operator) { q += ' AND a.operator = ?'; params.push(operator); }
    }
    q += ' ORDER BY a.allocated_at ASC LIMIT 50';
    const sel = db.prepare(q);
    const del = db.prepare("DELETE FROM allocations WHERE id = ?");
    const claim = db.prepare("UPDATE allocations SET status='claiming' WHERE id = ? AND status = 'pool'");

    let row = null;
    let skipped = 0, lost = 0;
    for (const candidate of sel.all(...params)) {
      // Skip stale numbers that already received an OTP recently
      const recent = iprnBot?.getRecentOtpFor?.(candidate.phone_number);
      if (recent) { del.run(candidate.id); skipped++; continue; }
      const c = claim.run(candidate.id);
      if (c.changes === 1) { row = candidate; break; }
      lost++;
    }

    if (!row) {
      throw new Error(range
        ? `Range "${range}" has no fresh numbers (skipped ${skipped} stale, lost ${lost} race) — admin needs to refill`
        : 'No fresh IPRN numbers available — ask admin to add more');
    }
    if (skipped > 0 || lost > 0) console.log(`[iprn-provider] assigned ${row.phone_number} (skipped=${skipped} stale, lost=${lost} race)`);
    return {
      provider_ref: String(row.id),
      phone_number: row.phone_number,
      operator: row.operator,
      country_code: row.country_code,
      __pool_id: row.id,
    };
  },

  async checkOtp() { return { otp: null, status: 'waiting' }; },

  async releaseNumber(providerRef) {
    db.prepare("UPDATE allocations SET status = 'released' WHERE id = ?").run(+providerRef);
  },
};