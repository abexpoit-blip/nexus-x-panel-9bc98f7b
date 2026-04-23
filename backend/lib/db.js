// Singleton DB connection used by all routes
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || './data/nexus.db';

// Auto-create data dir
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

function _tableExists(table) {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
}

// --- Self-healing migrations (run by EVERY process that opens the DB,
//     so the tgbot worker doesn't crash if it starts before init.js) ---
function _ensureCol(table, col, ddl) {
  try {
    if (!_tableExists(table)) return;
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
      console.log(`[db] auto-migrated ${table}.${col}`);
    }
  } catch (e) {
    console.error(`[db] auto-migrate ${table}.${col} failed:`, e.message);
  }
}

function _ensureIndex(table, name, sql) {
  try {
    if (!_tableExists(table)) return;
    db.exec(sql);
  } catch (e) {
    console.error(`[db] ensure index ${name} failed:`, e.message);
  }
}
_ensureCol('tg_assignments', 'batch_id', 'TEXT');
_ensureCol('tg_assignments', 'tg_message_id', 'INTEGER');
_ensureCol('tg_assignments', 'tg_chat_id', 'INTEGER');
_ensureCol('cdr', 'note', 'TEXT');
_ensureCol('cdr', 'cli', 'TEXT');
_ensureCol('allocations', 'cli', 'TEXT');
_ensureIndex('allocations', 'idx_allocations_provider_phone_status_allocated', 'CREATE INDEX IF NOT EXISTS idx_allocations_provider_phone_status_allocated ON allocations(provider, phone_number, status, allocated_at DESC)');
_ensureIndex('allocations', 'idx_allocations_status_provider_ref_allocated', 'CREATE INDEX IF NOT EXISTS idx_allocations_status_provider_ref_allocated ON allocations(status, provider_ref, allocated_at DESC)');
_ensureIndex('allocations', 'idx_allocations_user_allocated', 'CREATE INDEX IF NOT EXISTS idx_allocations_user_allocated ON allocations(user_id, allocated_at DESC)');
_ensureIndex('notifications', 'idx_notifications_user_read_created', 'CREATE INDEX IF NOT EXISTS idx_notifications_user_read_created ON notifications(user_id, is_read, created_at DESC)');
_ensureIndex('otp_audit_log', 'idx_otp_audit_provider_phone_otp_event_ts', 'CREATE INDEX IF NOT EXISTS idx_otp_audit_provider_phone_otp_event_ts ON otp_audit_log(provider, phone_number, otp_code, event, ts DESC)');
_ensureIndex('sessions', 'idx_sessions_token_hash', 'CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash)');
_ensureIndex('sessions', 'idx_sessions_user_expires', 'CREATE INDEX IF NOT EXISTS idx_sessions_user_expires ON sessions(user_id, expires_at DESC)');

module.exports = db;
