import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'data');
fs.mkdirSync(dir, { recursive: true });

export const db = new DatabaseSync(path.join(dir, 'kcom.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','manager','viewer','tv')),
  active INTEGER NOT NULL DEFAULT 1,
  must_change INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  totp_secret_enc TEXT,
  totp_pending_enc TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_login INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  ip TEXT, ua TEXT,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  manager_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  monthly_budget REAL,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('google','meta')),
  account_id TEXT NOT NULL DEFAULT '',
  metric TEXT NOT NULL DEFAULT 'cpl',
  target REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (client_id, platform)
);
CREATE TABLE IF NOT EXISTS metrics_daily (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  spend REAL NOT NULL DEFAULT 0,
  conversions REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, date)
);
CREATE TABLE IF NOT EXISTS channel_status (
  channel_id INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  balance REAL,
  last_sync INTEGER,
  error TEXT
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  ack_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ack_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_alerts_open ON alerts(channel_id, type, resolved_at);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_enc TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL DEFAULT (unixepoch()),
  user_id INTEGER,
  user_name TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  ip TEXT
);
CREATE TABLE IF NOT EXISTS report_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
`);

try { db.exec("ALTER TABLE channels ADD COLUMN result_type TEXT NOT NULL DEFAULT 'auto'"); } catch { /* coluna já existe */ }
try { db.exec('ALTER TABLE channel_status ADD COLUMN funding TEXT'); } catch { /* coluna já existe */ }

for (const col of ['impressions', 'clicks', 'reach']) {
  try { db.exec(`ALTER TABLE metrics_daily ADD COLUMN ${col} REAL NOT NULL DEFAULT 0`); } catch { /* já existe */ }
}

// Migração: bancos antigos tinham CHECK (metric IN ('cpl','cpa')), que impede seguidores/alcance.
if (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'channels'").get().sql.includes('CHECK (metric')) {
  db.exec('PRAGMA foreign_keys = OFF; BEGIN;');
  db.exec(`CREATE TABLE channels_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    platform TEXT NOT NULL CHECK (platform IN ('google','meta')),
    account_id TEXT NOT NULL DEFAULT '',
    metric TEXT NOT NULL DEFAULT 'cpl',
    target REAL NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    result_type TEXT NOT NULL DEFAULT 'auto',
    UNIQUE (client_id, platform)
  );
  INSERT INTO channels_new (id, client_id, platform, account_id, metric, target, active, result_type)
    SELECT id, client_id, platform, account_id, metric, target, active, result_type FROM channels;
  DROP TABLE channels; ALTER TABLE channels_new RENAME TO channels; COMMIT; PRAGMA foreign_keys = ON;`);
}

// forma de pagamento: 'detect' (lida da API), 'card' (cartão automático) ou 'manual' (recarga manual); manual sobrescreve a detecção
try { db.exec("ALTER TABLE channels ADD COLUMN pay_mode TEXT NOT NULL DEFAULT 'detect'"); } catch { /* coluna já existe */ }

export const get = (sql, ...p) => db.prepare(sql).get(...p);
export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const run = (sql, ...p) => {
  const r = db.prepare(sql).run(...p);
  return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
};

export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function audit(req, action, detail = '') {
  run(
    'INSERT INTO audit_log (user_id, user_name, action, detail, ip) VALUES (?,?,?,?,?)',
    req?.user?.id ?? null, req?.user?.name ?? null, action, String(detail).slice(0, 500), req?.ip ?? null,
  );
}
