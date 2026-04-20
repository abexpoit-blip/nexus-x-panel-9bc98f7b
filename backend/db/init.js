// Initialize SQLite database — create tables, seed admin user
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || './data/nexus.db';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// Ensure data directory exists
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);

// Apply schema
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Apply Telegram bot schema (additive)
const tgSchemaPath = path.join(__dirname, 'tg_schema.sql');
if (fs.existsSync(tgSchemaPath)) {
  db.exec(fs.readFileSync(tgSchemaPath, 'utf8'));
  console.log('✓ TG schema applied');
}

// --- Idempotent column-add migrations for existing databases ---
function addColIfMissing(table, col, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
    console.log(`✓ Migration: added ${table}.${col}`);
  }
}
addColIfMissing('withdrawals', 'admin_note', 'TEXT');
addColIfMissing('withdrawals', 'reviewed_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
addColIfMissing('withdrawals', 'reviewed_at', 'INTEGER');
addColIfMissing('allocations', 'cli', 'TEXT');
addColIfMissing('cdr', 'cli', 'TEXT');
addColIfMissing('cdr', 'note', 'TEXT');
addColIfMissing('tg_assignments', 'batch_id', 'TEXT');

// Seed default admin (only if no admin exists)
const adminExists = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin'").get();
if (adminExists.c === 0) {
  const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
  db.prepare(`
    INSERT INTO users (username, password_hash, role, full_name, balance)
    VALUES (?, ?, 'admin', 'System Admin', 0)
  `).run(ADMIN_USERNAME, hash);
  console.log(`✓ Default admin created: ${ADMIN_USERNAME} / ${ADMIN_PASSWORD}`);
  console.log('  IMPORTANT: Change this password immediately in production!');
}

console.log(`✓ Database ready at ${DB_PATH}`);
db.close();

module.exports = { DB_PATH };
