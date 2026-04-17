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
  // Accepts: { range } — exact match against the operator column, OR
  //          { countryCode, operator } for legacy callers.
  async getNumber({ range, countryCode, operator } = {}) {
    let q = "SELECT * FROM allocations WHERE provider = 'ims' AND status = 'pool'";
    const params = [];
    if (range) { q += ' AND COALESCE(operator, \'Unknown\') = ?'; params.push(range); }
    else {
      if (countryCode) { q += ' AND country_code = ?'; params.push(countryCode); }
      if (operator) { q += ' AND operator = ?'; params.push(operator); }
    }
    q += ' ORDER BY allocated_at ASC LIMIT 1';
    const row = db.prepare(q).get(...params);
    if (!row) {
      throw new Error(range
        ? `Range "${range}" is empty — admin needs to refill`
        : 'No IMS numbers available — ask admin to add more');
    }
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
