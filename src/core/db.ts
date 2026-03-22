import Database from 'better-sqlite3';
import { join } from 'path';

// Use DATA_DIR env var if set (e.g. /data on Fly.io persistent volume),
// otherwise fall back to cwd for local development.
const DB_PATH = join(process.env.DATA_DIR ?? process.cwd(), '.nexus.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    migrate(_db);
  }
  return _db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS risk_spending (
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      total REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, date)
    );

    CREATE TABLE IF NOT EXISTS risk_limits (
      user_id TEXT PRIMARY KEY,
      max_transaction_usdt REAL NOT NULL,
      daily_limit_usdt REAL NOT NULL,
      max_slippage_percent REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_user
      ON conversations (user_id, timestamp DESC);

    CREATE TABLE IF NOT EXISTS user_account_contexts (
      user_id TEXT NOT NULL,
      chain TEXT NOT NULL,
      account_index INTEGER NOT NULL DEFAULT 0,
      execution_mode TEXT NOT NULL DEFAULT 'approval_gated' CHECK (execution_mode IN ('approval_gated', 'delegated')),
      wallet_mode TEXT NOT NULL DEFAULT 'inherit' CHECK (wallet_mode IN ('inherit', 'eoa', 'erc4337')),
      owner_address TEXT,
      smart_account_address TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (user_id, chain)
    );

    CREATE INDEX IF NOT EXISTS idx_user_account_contexts_chain
      ON user_account_contexts (chain, account_index);

    CREATE INDEX IF NOT EXISTS idx_user_account_contexts_owner_chain
      ON user_account_contexts (owner_address, chain);

    CREATE TABLE IF NOT EXISTS web_auth_challenges (
      owner_address TEXT PRIMARY KEY,
      challenge_message TEXT NOT NULL,
      nonce TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS web_sessions (
      session_token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      owner_address TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_web_sessions_user
      ON web_sessions (user_id, expires_at DESC);

    CREATE TABLE IF NOT EXISTS autopilot_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS treasury_policies (
      user_id TEXT PRIMARY KEY,
      reserve_floor_usdt REAL NOT NULL DEFAULT 25,
      target_xaut_percent REAL NOT NULL DEFAULT 0.15,
      max_xaut_percent REAL NOT NULL DEFAULT 0.30,
      max_yield_percent REAL NOT NULL DEFAULT 0.60,
      min_rebalance_usdt REAL NOT NULL DEFAULT 10,
      min_yield_deploy_usdt REAL NOT NULL DEFAULT 10,
      max_action_usdt REAL NOT NULL DEFAULT 75,
      rebalance_cooldown_seconds INTEGER NOT NULL DEFAULT 1800,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS tx_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      intent TEXT NOT NULL,
      agent TEXT NOT NULL,
      amount_usdt REAL,
      tx_hash TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      metadata TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tx_log_user
      ON tx_log (user_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_tx_log_user_intent_created
      ON tx_log (user_id, intent, created_at DESC);

    CREATE TABLE IF NOT EXISTS rules (
      id TEXT PRIMARY KEY,
      natural_language TEXT NOT NULL,
      condition_json TEXT NOT NULL,
      action_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      fired_count INTEGER NOT NULL DEFAULT 0,
      last_fired_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  try {
    db.exec(`ALTER TABLE rules ADD COLUMN user_id TEXT NOT NULL DEFAULT '__global__';`);
  } catch {
    // Column already exists on upgraded databases
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_rules_user_created
      ON rules (user_id, created_at DESC);
  `);
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
