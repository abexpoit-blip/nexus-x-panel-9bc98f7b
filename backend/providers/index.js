// Provider registry — add new providers here
const acchub = require('./acchub');
const ims = require('./ims');
const msi = require('./msi');
const numpanel = require('./numpanel');
const iprn = require('./iprn');

const providers = {
  acchub,
  ims,
  msi,
  numpanel,
  iprn,
};

function get(id) {
  const p = providers[id];
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}

function list() {
  return Object.values(providers).map(p => ({ id: p.id, name: p.name, mode: p.mode || 'auto' }));
}

module.exports = { get, list, providers };
