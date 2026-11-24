import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Overridable so bundled deployments (Vercel) can point at the files shipped next to the function.
export const ROOT = process.env.CONTEXTLOOP_ROOT ?? path.resolve(here, "..", "..");
export const DATA_DIR = process.env.CONTEXTLOOP_DATA_DIR ?? path.join(ROOT, "data");
export const DB_PATH = path.join(DATA_DIR, "contextloop.db");
fs.mkdirSync(DATA_DIR, { recursive: true });

function openDatabase(): DatabaseSync {
  const d = new DatabaseSync(DB_PATH);
  d.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  d.exec(SCHEMA);
  return d;
}

/** Close the connection (before the file is replaced by a newer snapshot). Safe to call twice. */
export function closeDatabase() {
  try {
    db.close();
  } catch {}
}

/** (Re)open the database file, e.g. after a newer snapshot was restored over it. */
export function reopenDatabase() {
  closeDatabase();
  db = openDatabase();
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL,
  title TEXT, color TEXT
);
CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT);
CREATE TABLE IF NOT EXISTS team_members (team_id TEXT, user_id TEXT, PRIMARY KEY (team_id, user_id));
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, owner_id TEXT, team_id TEXT
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, team_id TEXT,
  restricted INTEGER NOT NULL DEFAULT 0, entity_id TEXT
);
CREATE TABLE IF NOT EXISTS api_keys (
  key TEXT PRIMARY KEY, name TEXT NOT NULL, user_id TEXT NOT NULL, scopes TEXT NOT NULL,
  max_visibility TEXT NOT NULL DEFAULT 'team', allowed_projects TEXT, created_at TEXT, last_used_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
  status TEXT NOT NULL DEFAULT 'connected', last_sync_at TEXT, config TEXT
);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, source_kind TEXT NOT NULL, title TEXT NOT NULL, filename TEXT,
  mime TEXT, content_hash TEXT NOT NULL, raw_path TEXT, text TEXT NOT NULL, metadata TEXT,
  project_id TEXT, owner_id TEXT, visibility TEXT NOT NULL DEFAULT 'org', team_id TEXT,
  occurred_at TEXT, ingested_at TEXT NOT NULL, size_bytes INTEGER, duplicate_of TEXT
);
CREATE INDEX IF NOT EXISTS idx_docs_hash ON documents(content_hash);
CREATE TABLE IF NOT EXISTS imports (
  id TEXT PRIMARY KEY, filename TEXT, source_kind TEXT, status TEXT NOT NULL, stage TEXT,
  started_at TEXT, finished_at TEXT, doc_ids TEXT, stats TEXT, error TEXT, user_id TEXT, origin TEXT
);
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, idx INTEGER NOT NULL, text TEXT NOT NULL,
  speaker TEXT, FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, key TEXT NOT NULL,
  aliases TEXT, attributes TEXT, description TEXT, created_at TEXT, updated_at TEXT,
  UNIQUE (type, key)
);
CREATE TABLE IF NOT EXISTS mentions (
  entity_id TEXT NOT NULL, doc_id TEXT NOT NULL, chunk_id TEXT, snippet TEXT,
  PRIMARY KEY (entity_id, doc_id, chunk_id)
);
CREATE INDEX IF NOT EXISTS idx_mentions_doc ON mentions(doc_id);
CREATE TABLE IF NOT EXISTS relations (
  id TEXT PRIMARY KEY, src_id TEXT NOT NULL, dst_id TEXT NOT NULL, type TEXT NOT NULL,
  doc_id TEXT, confidence REAL, snippet TEXT, UNIQUE (src_id, dst_id, type, doc_id)
);
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, predicate TEXT NOT NULL, value TEXT NOT NULL,
  doc_id TEXT, snippet TEXT, speaker TEXT, observed_at TEXT, authority REAL, confidence REAL,
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_claims_entity ON claims(entity_id, predicate);
CREATE TABLE IF NOT EXISTS conflicts (
  id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, predicate TEXT NOT NULL, status TEXT NOT NULL,
  proposed_claim_id TEXT, resolved_claim_id TEXT, rationale TEXT, scores TEXT,
  resolved_by TEXT, resolved_at TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS entity_history (
  id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, field TEXT, old_value TEXT, new_value TEXT,
  doc_id TEXT, actor TEXT, note TEXT, at TEXT
);
CREATE TABLE IF NOT EXISTS source_authority (
  source_kind TEXT PRIMARY KEY, weight REAL NOT NULL, note TEXT
);
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, description TEXT,
  category TEXT, active_version INTEGER NOT NULL DEFAULT 1, owner_id TEXT, harnesses TEXT,
  created_at TEXT, synced_at TEXT
);
CREATE TABLE IF NOT EXISTS skill_versions (
  id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL,
  changelog TEXT, created_by TEXT, created_at TEXT, proposal_id TEXT, UNIQUE (skill_id, version)
);
CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY, agent TEXT NOT NULL, harness TEXT, skill_id TEXT, skill_version INTEGER,
  task TEXT, project_id TEXT, status TEXT NOT NULL, error_type TEXT, error_message TEXT,
  signature TEXT, tokens_in INTEGER, tokens_out INTEGER, latency_ms INTEGER, cost_usd REAL,
  started_at TEXT, steps TEXT, fault TEXT, origin TEXT, user_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_traces_skill ON traces(skill_id, started_at);
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, skill_id TEXT, base_version INTEGER, title TEXT,
  issue TEXT, analysis TEXT, proposed_content TEXT, proposed_name TEXT, evidence TEXT,
  stats TEXT, status TEXT NOT NULL, generator TEXT, eval_run_id TEXT, created_at TEXT,
  created_by TEXT, decided_by TEXT, decided_at TEXT, decision_note TEXT
);
CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY, proposal_id TEXT, skill_id TEXT, baseline_label TEXT, candidate_label TEXT,
  baseline_policy TEXT, candidate_policy TEXT, results TEXT, baseline_rate REAL,
  candidate_rate REAL, compiler TEXT, created_at TEXT, duration_ms INTEGER
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor_type TEXT, actor_id TEXT,
  actor_name TEXT, action TEXT NOT NULL, resource TEXT, detail TEXT, outcome TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_threads (id TEXT PRIMARY KEY, user_id TEXT, title TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
  meta TEXT, at TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
-- Raw lake: byte-exact uploads, content-addressed. Kept inside the database so a single
-- file holds the complete state (portable to Vercel Blob / S3 snapshots).
CREATE TABLE IF NOT EXISTS raw_objects (key TEXT PRIMARY KEY, data BLOB NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL);
`;

/** Live binding: reopenDatabase() swaps it, and every importer sees the new handle. */
export let db: DatabaseSync = openDatabase();

export type Row = any; // SQLite rows are dynamically shaped

export const all = <T = Row>(sql: string, ...params: any[]): T[] =>
  db.prepare(sql).all(...params) as T[];
export const get = <T = Row>(sql: string, ...params: any[]): T | undefined =>
  db.prepare(sql).get(...params) as T | undefined;
export const run = (sql: string, ...params: any[]) => db.prepare(sql).run(...params);

export function tx<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export const now = () => new Date().toISOString();
let counter = 0;
export const uid = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${(counter++ % 1296).toString(36).padStart(2, "0")}${Math.random().toString(36).slice(2, 6)}`;

export const json = <T = any>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export function getSetting<T>(key: string, fallback: T): T {
  const r = get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
  return r ? json<T>(r.value, fallback) : fallback;
}
export function setSetting(key: string, value: unknown) {
  run("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value));
}

export function resetDatabase() {
  const tables = all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  db.exec("PRAGMA foreign_keys = OFF");
  for (const t of tables) db.exec(`DELETE FROM ${t.name}`);
  db.exec("PRAGMA foreign_keys = ON");
}

export function putRaw(key: string, data: Buffer) {
  run("INSERT OR IGNORE INTO raw_objects(key, data, size, created_at) VALUES (?,?,?,?)", key, data, data.length, now());
}
export function getRaw(key: string | null | undefined): Buffer | null {
  if (!key) return null;
  const r = get<{ data: Uint8Array }>("SELECT data FROM raw_objects WHERE key = ?", key);
  return r ? Buffer.from(r.data) : null;
}
