import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  raw_text TEXT NOT NULL DEFAULT '',
  chips_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  avoid_json TEXT NOT NULL DEFAULT '[]',
  events_since_synth INTEGER NOT NULL DEFAULT 0,
  synth_count INTEGER NOT NULL DEFAULT 0,
  onboarded INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS interests (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  weight REAL NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0,
  positive INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL,            -- onboarding | learned | ai
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, tag)
);
CREATE TABLE IF NOT EXISTS source_affinity (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  score_sum REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, source)
);
CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,            -- youtube | tiktok | instagram
  external_id TEXT NOT NULL,
  embed_kind TEXT NOT NULL,        -- youtube | tiktok | instagram
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  creator TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  thumbnail TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  tags_json TEXT NOT NULL DEFAULT '[]',   -- [{tag, relevance}]
  query TEXT NOT NULL DEFAULT '',
  tagged INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (source, external_id)
);
CREATE TABLE IF NOT EXISTS impressions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  served_at INTEGER NOT NULL,
  watched_ms INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  replays INTEGER NOT NULL DEFAULT 0,
  liked INTEGER NOT NULL DEFAULT 0,
  shared INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  score REAL NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  finalized INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_impressions_user ON impressions(user_id, served_at);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  impression_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS discovery_queries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  query TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_run_at INTEGER,
  items_found INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, source, query)
);
CREATE TABLE IF NOT EXISTS query_runs (
  source TEXT NOT NULL,
  query_norm TEXT NOT NULL,
  last_run_at INTEGER NOT NULL,
  items_found INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source, query_norm)
);
CREATE TABLE IF NOT EXISTS quota_ledger (
  source TEXT NOT NULL,
  day TEXT NOT NULL,                -- YYYY-MM-DD in UTC (YouTube resets at midnight Pacific; we stay conservative)
  units INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source, day)
);
CREATE TABLE IF NOT EXISTS synth_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  changes_json TEXT NOT NULL,
  mode TEXT NOT NULL,              -- ai | heuristic
  created_at INTEGER NOT NULL
);
`);

// Columns added after the first release are created on boot if missing.
const videoCols = new Set(db.prepare("PRAGMA table_info(videos)").all().map((c) => c.name));
for (const [name, ddl] of [
  ["media_src", "TEXT NOT NULL DEFAULT ''"],    // remote file URL the clip can be downloaded from
  ["media_file", "TEXT NOT NULL DEFAULT ''"],   // filename in the local media cache, when present
  ["media_bytes", "INTEGER NOT NULL DEFAULT 0"],
  ["media_at", "INTEGER NOT NULL DEFAULT 0"],   // last time it was watched (for eviction)
  ["media_fails", "INTEGER NOT NULL DEFAULT 0"],
]) if (!videoCols.has(name)) db.exec(`ALTER TABLE videos ADD COLUMN ${name} ${ddl}`);

export const now = () => Date.now();
export const uid = () => crypto.randomUUID();

// Small helpers so route code stays readable.
export const q = {
  get: (sql, ...params) => db.prepare(sql).get(...params),
  all: (sql, ...params) => db.prepare(sql).all(...params),
  run: (sql, ...params) => db.prepare(sql).run(...params),
};

export function transaction(fn) {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
