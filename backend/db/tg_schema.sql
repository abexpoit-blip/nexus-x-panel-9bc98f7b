-- NEXUS X Telegram Bot — schema additions
-- Auto-applied by db/init.js

CREATE TABLE IF NOT EXISTS tg_users (
  tg_user_id   INTEGER PRIMARY KEY,            -- Telegram numeric id
  username     TEXT,
  first_name   TEXT,
  language     TEXT DEFAULT 'en',
  balance_bdt  REAL NOT NULL DEFAULT 0,
  total_otps   INTEGER NOT NULL DEFAULT 0,
  total_spent  REAL NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'active', -- active | banned
  notes        TEXT,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  last_seen_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_tg_users_status ON tg_users(status, last_seen_at);

CREATE TABLE IF NOT EXISTS tg_wallet_tx (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_user_id   INTEGER NOT NULL REFERENCES tg_users(tg_user_id) ON DELETE CASCADE,
  amount_bdt   REAL NOT NULL,                  -- +ve = credit, -ve = debit
  type         TEXT NOT NULL,                  -- topup | deduct | refund | adjust
  ref_id       INTEGER,                        -- assignment id when applicable
  note         TEXT,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_tg_wtx_user ON tg_wallet_tx(tg_user_id, created_at);

-- Per-(provider, range) TG availability + pricing
CREATE TABLE IF NOT EXISTS range_tg_settings (
  provider     TEXT NOT NULL,
  range_name   TEXT NOT NULL,
  tg_enabled   INTEGER NOT NULL DEFAULT 0,
  tg_rate_bdt  REAL NOT NULL DEFAULT 0,        -- price charged per OTP success
  service      TEXT,                            -- facebook | whatsapp | telegram | tiktok | other
  updated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (provider, range_name)
);

-- TG number assignments (independent of agent allocations.user_id which is FK to users)
CREATE TABLE IF NOT EXISTS tg_assignments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_user_id      INTEGER NOT NULL REFERENCES tg_users(tg_user_id) ON DELETE CASCADE,
  allocation_id   INTEGER NOT NULL REFERENCES allocations(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,
  phone_number    TEXT NOT NULL,
  country_code    TEXT,
  range_name      TEXT,
  service         TEXT,
  rate_bdt        REAL NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active', -- active | otp_received | expired | released
  otp_code        TEXT,
  otp_full_text   TEXT,
  batch_id        TEXT,                            -- groups assignments claimed together (single card)
  tg_message_id   INTEGER,                         -- chat message that contains the batch card
  tg_chat_id      INTEGER,
  assigned_at     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  expires_at      INTEGER NOT NULL,
  otp_received_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tga_user_status ON tg_assignments(tg_user_id, status);
CREATE INDEX IF NOT EXISTS idx_tga_alloc      ON tg_assignments(allocation_id);
CREATE INDEX IF NOT EXISTS idx_tga_expiry     ON tg_assignments(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_tga_recv       ON tg_assignments(otp_received_at);
CREATE INDEX IF NOT EXISTS idx_tga_batch      ON tg_assignments(batch_id);

CREATE TABLE IF NOT EXISTS tg_broadcasts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  message      TEXT NOT NULL,
  parse_mode   TEXT DEFAULT 'HTML',
  sent_count   INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | sending | done | failed
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  finished_at  INTEGER
);
