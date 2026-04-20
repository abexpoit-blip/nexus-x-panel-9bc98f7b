// MSI provider — manual pool from msiBot scraper
// Mirrors backend/providers/ims.js exactly, but with provider='msi' and references msiBot.
const db = require('../lib/db');

module.exports = {
  id: 'msi',
  name: 'MSI SMS',
  mode: 'manual',

  async listCountries() {
    return db.prepare(`
      SELECT DISTINCT country_code as code, COALESCE(country_name, country_code) as name
      FROM rates WHERE provider = 'msi' AND country_code IS NOT NULL
    `).all();
  },

  async listOperators() {
    return db.prepare(`
      SELECT DISTINCT operator as name FROM rates
      WHERE provider = 'msi' AND operator IS NOT NULL
    `).all();
  },

  // Distinct ranges currently in pool
  async listRanges() {
    return db.prepare(`
      SELECT
        COALESCE(operator, 'Unknown') AS name,
        COUNT(*) AS count
      FROM allocations
      WHERE provider = 'msi' AND status = 'pool'
      GROUP BY COALESCE(operator, 'Unknown')
      HAVING count > 0
      ORDER BY name ASC
    `).all();
  },

  // Pull next available number from MSI pool. Atomic claim like IMS.
  async getNumber({ range, countryCode, operator } = {}) {
    let msiBot = null;
    try { msiBot = require('../workers/msiBot'); } catch (_) {}

    let q = "SELECT id, phone_number, operator, country_code FROM allocations WHERE provider = 'msi' AND status = 'pool'";
    const params = [];
    if (range) { q += ' AND COALESCE(operator, \'Unknown\') = ?'; params.push(range); }
    else {
      if (countryCode) { q += ' AND country_code = ?'; params.push(countryCode); }
      if (operator) { q += ' AND operator = ?'; params.push(operator); }
    }
    q += ' ORDER BY allocated_at ASC LIMIT 50';
    const sel = db.prepare(q);
    const del = db.prepare("DELETE FROM allocations WHERE id = ?");
    const claim = db.prepare("UPDATE allocations SET status='claiming' WHERE id = ? AND status = 'pool'");

    let row = null;
    let skipped = 0, lost = 0;
    for (const candidate of sel.all(...params)) {
      // Skip stale numbers that already received an OTP recently
      const recent = msiBot?.getRecentOtpFor?.(candidate.phone_number);
      if (recent) { del.run(candidate.id); skipped++; continue; }
      const c = claim.run(candidate.id);
      if (c.changes === 1) { row = candidate; break; }
      lost++;
    }

    if (!row) {
      throw new Error(range
        ? `Range "${range}" has no fresh numbers (skipped ${skipped} stale, lost ${lost} race) — admin needs to refill`
        : 'No fresh MSI numbers available — ask admin to add more');
    }
    if (skipped > 0 || lost > 0) console.log(`[msi-provider] assigned ${row.phone_number} (skipped=${skipped} stale, lost=${lost} race)`);
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
