import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const dbPath = process.env.DB_PATH || './data/kv.db';
mkdirSync(dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.exec(`CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER
)`);

const stmtGet    = db.prepare('SELECT value, expires_at FROM kv WHERE key = ?');
const stmtPut    = db.prepare('INSERT OR REPLACE INTO kv (key, value, expires_at) VALUES (?, ?, ?)');
const stmtDel    = db.prepare('DELETE FROM kv WHERE key = ?');
const stmtExpire = db.prepare('DELETE FROM kv WHERE key = ?');
const stmtPrefix = db.prepare('SELECT key FROM kv WHERE key LIKE ?');
const stmtAll    = db.prepare('SELECT key FROM kv');

export const kv = {
  get(key) {
    const row = stmtGet.get(key);
    if (!row) return null;
    if (row.expires_at !== null && Math.floor(Date.now() / 1000) > row.expires_at) {
      stmtExpire.run(key);
      return null;
    }
    return row.value;
  },

  put(key, value, options) {
    const expires_at = options?.expirationTtl
      ? Math.floor(Date.now() / 1000) + options.expirationTtl
      : null;
    stmtPut.run(key, value, expires_at);
  },

  delete(key) {
    stmtDel.run(key);
  },

  list({ prefix } = {}) {
    const rows = prefix ? stmtPrefix.all(prefix + '%') : stmtAll.all();
    return { keys: rows.map(r => ({ name: r.key })) };
  },
};
