import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, unlinkSync } from 'fs';

const TEST_DB_PATH = join(process.cwd(), '.nexus-test.db');

function createTestDb(): Database.Database {
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
  const db = new Database(TEST_DB_PATH);
  db.pragma('journal_mode = WAL');
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
  `);
  return db;
}

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

afterAll(() => {
  db?.close();
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
});

describe('risk_spending table', () => {
  it('inserts and retrieves spending', () => {
    db.prepare('INSERT INTO risk_spending (user_id, date, total) VALUES (?, ?, ?)').run('user1', '2026-03-15', 100);
    const row = db.prepare('SELECT total FROM risk_spending WHERE user_id = ? AND date = ?').get('user1', '2026-03-15') as { total: number };
    expect(row.total).toBe(100);
  });

  it('upserts spending with ON CONFLICT', () => {
    db.prepare('INSERT INTO risk_spending (user_id, date, total) VALUES (?, ?, ?)').run('user1', '2026-03-15', 100);
    db.prepare(`
      INSERT INTO risk_spending (user_id, date, total) VALUES (?, ?, ?)
      ON CONFLICT (user_id, date) DO UPDATE SET total = total + excluded.total
    `).run('user1', '2026-03-15', 50);
    const row = db.prepare('SELECT total FROM risk_spending WHERE user_id = ? AND date = ?').get('user1', '2026-03-15') as { total: number };
    expect(row.total).toBe(150);
  });

  it('separates spending by user and date', () => {
    db.prepare('INSERT INTO risk_spending (user_id, date, total) VALUES (?, ?, ?)').run('user1', '2026-03-15', 100);
    db.prepare('INSERT INTO risk_spending (user_id, date, total) VALUES (?, ?, ?)').run('user2', '2026-03-15', 200);
    db.prepare('INSERT INTO risk_spending (user_id, date, total) VALUES (?, ?, ?)').run('user1', '2026-03-16', 300);

    const u1d1 = db.prepare('SELECT total FROM risk_spending WHERE user_id = ? AND date = ?').get('user1', '2026-03-15') as { total: number };
    const u2d1 = db.prepare('SELECT total FROM risk_spending WHERE user_id = ? AND date = ?').get('user2', '2026-03-15') as { total: number };
    const u1d2 = db.prepare('SELECT total FROM risk_spending WHERE user_id = ? AND date = ?').get('user1', '2026-03-16') as { total: number };

    expect(u1d1.total).toBe(100);
    expect(u2d1.total).toBe(200);
    expect(u1d2.total).toBe(300);
  });

  it('returns undefined for missing records', () => {
    const row = db.prepare('SELECT total FROM risk_spending WHERE user_id = ? AND date = ?').get('nobody', '2026-01-01');
    expect(row).toBeUndefined();
  });
});

describe('risk_limits table', () => {
  it('inserts and retrieves limits', () => {
    db.prepare('INSERT INTO risk_limits (user_id, max_transaction_usdt, daily_limit_usdt, max_slippage_percent) VALUES (?, ?, ?, ?)').run('user1', 500, 2000, 1);
    const row = db.prepare('SELECT * FROM risk_limits WHERE user_id = ?').get('user1') as Record<string, unknown>;
    expect(row.max_transaction_usdt).toBe(500);
    expect(row.daily_limit_usdt).toBe(2000);
  });

  it('upserts limits on conflict', () => {
    db.prepare('INSERT INTO risk_limits (user_id, max_transaction_usdt, daily_limit_usdt, max_slippage_percent) VALUES (?, ?, ?, ?)').run('user1', 500, 2000, 1);
    db.prepare(`
      INSERT INTO risk_limits (user_id, max_transaction_usdt, daily_limit_usdt, max_slippage_percent)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET
        max_transaction_usdt = excluded.max_transaction_usdt,
        daily_limit_usdt = excluded.daily_limit_usdt,
        max_slippage_percent = excluded.max_slippage_percent
    `).run('user1', 1000, 5000, 2);
    const row = db.prepare('SELECT * FROM risk_limits WHERE user_id = ?').get('user1') as Record<string, unknown>;
    expect(row.max_transaction_usdt).toBe(1000);
  });
});

describe('conversations table', () => {
  it('stores and retrieves messages in order', () => {
    db.prepare('INSERT INTO conversations (user_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run('user1', 'user', 'hello', 1000);
    db.prepare('INSERT INTO conversations (user_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run('user1', 'assistant', 'hi there', 2000);
    const rows = db.prepare('SELECT role, content FROM conversations WHERE user_id = ? ORDER BY timestamp ASC').all('user1') as Array<{ role: string; content: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].role).toBe('user');
    expect(rows[1].role).toBe('assistant');
  });

  it('rejects invalid roles', () => {
    expect(() => {
      db.prepare('INSERT INTO conversations (user_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run('user1', 'system', 'bad', 1000);
    }).toThrow();
  });

  it('isolates conversations by user', () => {
    db.prepare('INSERT INTO conversations (user_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run('user1', 'user', 'msg1', 1000);
    db.prepare('INSERT INTO conversations (user_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run('user2', 'user', 'msg2', 2000);
    const u1 = db.prepare('SELECT * FROM conversations WHERE user_id = ?').all('user1');
    const u2 = db.prepare('SELECT * FROM conversations WHERE user_id = ?').all('user2');
    expect(u1).toHaveLength(1);
    expect(u2).toHaveLength(1);
  });
});

describe('tx_log table', () => {
  it('logs a transaction', () => {
    db.prepare(`
      INSERT INTO tx_log (user_id, intent, agent, amount_usdt, tx_hash, status, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('user1', 'execute_swap', 'swap', 100, '0xabc', 'success', '{"tokenIn":"USDT"}');

    const row = db.prepare('SELECT * FROM tx_log WHERE user_id = ?').get('user1') as Record<string, unknown>;
    expect(row.intent).toBe('execute_swap');
    expect(row.agent).toBe('swap');
    expect(row.amount_usdt).toBe(100);
    expect(row.status).toBe('success');
  });

  it('auto-increments ids', () => {
    db.prepare('INSERT INTO tx_log (user_id, intent, agent, status) VALUES (?, ?, ?, ?)').run('u1', 'a', 'b', 'ok');
    db.prepare('INSERT INTO tx_log (user_id, intent, agent, status) VALUES (?, ?, ?, ?)').run('u1', 'c', 'd', 'ok');
    const rows = db.prepare('SELECT id FROM tx_log ORDER BY id').all() as Array<{ id: number }>;
    expect(rows[1].id).toBeGreaterThan(rows[0].id);
  });
});
