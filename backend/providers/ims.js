// IMS provider — HYBRID MODE
//   • Auto: imsBot scrapes numbers + OTP from imssms.org into the pool
//   • Manual: admin can paste numbers OR push OTPs via admin endpoints
//
// Agents pick a RANGE (e.g. "Peru Bitel TF04") instead of country/operator,
// because IMS organizes inventory by Range (= operator/carrier label).
const db = require('../lib/db');

module.exports = {
  id: 'ims',
  name: 'IMS SMS',
  mode: 'manual',

  async listCountries() {
    // Distinct countries from existing rates for IMS (kept for compatibility)
    return db.prepare(`
      SELECT DISTINCT country_code as code, COALESCE(country_name, country_code) as name
      FROM rates WHERE provider = 'ims' AND country_code IS NOT NULL
    `).all();
  },

  async listOperators() {
    return db.prepare(`
      SELECT DISTINCT operator as name FROM rates
      WHERE provider = 'ims' AND operator IS NOT NULL
    `).all();
  },

  // Distinct ranges currently sitting in the pool (status='pool')
  // Returns: [{ name: 'Peru Bitel TF04', count: 247 }, ...]
  async listRanges() {
    return db.prepare(`
      SELECT
        COALESCE(operator, 'Unknown') AS name,
        COUNT(*) AS count
      FROM allocations
      WHERE provider = 'ims' AND status = 'pool'
      GROUP BY COALESCE(operator, 'Unknown')
      HAVING count > 0
      ORDER BY name ASC
    `).all();
  },

  // Pull next available number from manual IMS pool (FIFO).
  // SKIPS numbers that have a recent OTP in IMS (already used by previous user) —
  // automatically deletes them from pool and tries the next one. Up to 20 attempts.
  async getNumber({ range, countryCode, operator } = {}) {
    let imsBot = null;
    try { imsBot = require('../workers/imsBot'); } catch (_) {}

    // Build candidate-selection query (LIMIT 1 with FIFO on allocated_at).
    // We MUST atomically claim the row so that 10 parallel /numbers/get workers
    // don't all grab the same pool entry. SQLite is single-writer, so a
    // SELECT-then-UPDATE-WHERE-status='pool' pattern guarantees only one
    // claimer succeeds (claim.changes === 1); losers retry the next candidate.
    let q = "SELECT id, phone_number, operator, country_code FROM allocations WHERE provider = 'ims' AND status = 'pool'";
    const params = [];
    if (range) { q += ' AND COALESCE(operator, \'Unknown\') = ?'; params.push(range); }
    else {
      if (countryCode) { q += ' AND country_code = ?'; params.push(countryCode); }
      if (operator) { q += ' AND operator = ?'; params.push(operator); }
    }
    // Limit large enough to skip stale + lose-the-race candidates without thrashing
    q += ' ORDER BY allocated_at ASC LIMIT 50';
    const sel = db.prepare(q);
    const del = db.prepare("DELETE FROM allocations WHERE id = ?");
    // Atomic claim: only succeeds if this row is STILL in 'pool' status.
    // Marks it 'claiming' so concurrent workers skip it; final status flip to
    // 'active' happens in the transaction in routes/numbers.js (with user_id).
    const claim = db.prepare("UPDATE allocations SET status='claiming' WHERE id = ? AND status = 'pool'");

    let row = null;
    let skipped = 0;
    let lost = 0;
    const candidates = sel.all(...params);
    for (const candidate of candidates) {
      // Check if this number was used recently (last 30min) per IMS scrape cache
      const recent = imsBot?.getRecentOtpFor?.(candidate.phone_number);
      if (recent) {
        del.run(candidate.id);
        skipped++;
        continue;
      }
      // Atomic claim attempt
      const c = claim.run(candidate.id);
      if (c.changes === 1) {
        row = candidate;
        break;
      } else {
        lost++; // another worker grabbed it first — try the next candidate
      }
    }

    if (!row) {
      throw new Error(range
        ? `Range "${range}" has no fresh numbers (skipped ${skipped} stale, lost ${lost} race) — admin needs to refill`
        : 'No fresh IMS numbers available — ask admin to add more');
    }
    if (skipped > 0 || lost > 0) console.log(`[ims-provider] assigned ${row.phone_number} (skipped=${skipped} stale, lost=${lost} race)`);
    return {
      provider_ref: String(row.id),
      phone_number: row.phone_number,
      operator: row.operator,
      country_code: row.country_code,
      __pool_id: row.id,
    };
  },

  async checkOtp() {
    return { otp: null, status: 'waiting' };
  },

  async releaseNumber(providerRef) {
    db.prepare("UPDATE allocations SET status = 'released' WHERE id = ?").run(+providerRef);
  },
};
