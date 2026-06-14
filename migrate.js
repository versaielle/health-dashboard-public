// One-time migration: Cloudflare KV → SQLite
// Run from repo root: node migrate.js
// Requires: wrangler authenticated, DB_PATH set or defaults to ./data/kv.db
//
// Keys migrated:  recipes, meal-log:*, grocery:user:*, family_access, cal_urls,
//                 wake_times, workout_overrides, health:sleep:*, kroger_token,
//                 google_token, ms_token_*
//
// Keys skipped:   session_* (users re-login), fs:search:* and fs:food:* (cache rebuilds)

import { execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const NS_ID  = 'f1c0f35c9b32453f803e39aba79ebbf7';
const DB_PATH = process.env.DB_PATH || './data/kv.db';

const SKIP_PREFIXES = ['session_', 'fs:search:', 'fs:food:'];

function shouldSkip(key) {
  return SKIP_PREFIXES.some(p => key.startsWith(p));
}

function wrangler(args) {
  return execSync(`npx wrangler ${args} --namespace-id ${NS_ID} --remote`, {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  }).trim();
}

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER
)`);
const stmtPut = db.prepare('INSERT OR REPLACE INTO kv (key, value, expires_at) VALUES (?, ?, ?)');

console.log('Fetching key list from Cloudflare KV...');
const listJson = wrangler(`kv key list`);
const keys     = JSON.parse(listJson).map(k => k.name);
console.log(`Found ${keys.length} keys. Skipping session/cache keys...`);

let imported = 0, skipped = 0;
for (const key of keys) {
  if (shouldSkip(key)) { skipped++; continue; }
  try {
    const value = wrangler(`kv key get "${key}"`);
    stmtPut.run(key, value, null);
    console.log(`  ✓ ${key}`);
    imported++;
  } catch (e) {
    console.error(`  ✗ ${key}: ${e.message}`);
  }
}

console.log(`\nDone. Imported: ${imported}, Skipped: ${skipped}`);
console.log(`Database: ${DB_PATH}`);
