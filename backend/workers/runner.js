require('dotenv').config();

require('../db/init');

console.log('🚀 NexusX workers starting');
require('./index').startAll();

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));