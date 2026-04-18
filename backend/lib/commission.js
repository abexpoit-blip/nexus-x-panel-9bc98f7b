// Calculate agent payout for a successful OTP based on rate card
const db = require('./db');

function findRate({ provider, country_code, operator }) {
  // Most specific match first
  const queries = [
    "SELECT * FROM rates WHERE provider=? AND country_code=? AND operator=? AND active=1 LIMIT 1",
    "SELECT * FROM rates WHERE provider=? AND country_code=? AND (operator IS NULL OR operator='') AND active=1 LIMIT 1",
    "SELECT * FROM rates WHERE provider=? AND (country_code IS NULL OR country_code='') AND active=1 LIMIT 1",
  ];
  return db.prepare(queries[0]).get(provider, country_code, operator)
      || db.prepare(queries[1]).get(provider, country_code)
      || db.prepare(queries[2]).get(provider);
}

function agentPayout({ provider, country_code, operator }) {
  const rate = findRate({ provider, country_code, operator });
  if (!rate) return { agent_amount: 0, rate_id: null, percent: 0, base: 0 };
  const base = +rate.price_bdt || 0;
  const percent = +rate.agent_commission_percent || 0;
  const agent_amount = +(base * percent / 100).toFixed(2);
  return { agent_amount, rate_id: rate.id, percent, base };
}

module.exports = { findRate, agentPayout };
