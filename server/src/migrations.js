// Numbered schema migrations. Each runs once, in order, inside a transaction, and is recorded
// in schema_migrations. Add new ones to the end; never edit one that has shipped.

export const MIGRATIONS = [
  {
    version: 1,
    name: "reels_ranking_signals",
    sql: `
      -- One row per engagement event the app logs (batched from the player).
      CREATE TABLE IF NOT EXISTS engagement_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        impression_id TEXT,
        type TEXT NOT NULL,              -- view | like | unlike | share | copy_link | save | unsave | hide
        watched_ms INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        completion REAL NOT NULL DEFAULT 0,
        rewatches INTEGER NOT NULL DEFAULT 0,
        quick_skip INTEGER NOT NULL DEFAULT 0,
        value REAL NOT NULL DEFAULT 0,   -- what it added to the viewer's affinities
        applied INTEGER NOT NULL DEFAULT 0, -- 0 = duplicate, logged but not counted
        client_ts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_engagement_user ON engagement_events(user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_engagement_imp ON engagement_events(impression_id, type);

      -- Everyone's engagement with a clip, as running totals (no user ids).
      CREATE TABLE IF NOT EXISTS clip_stats (
        video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
        views INTEGER NOT NULL DEFAULT 0,
        completion_sum REAL NOT NULL DEFAULT 0,
        quick_skips INTEGER NOT NULL DEFAULT 0,
        rewatches INTEGER NOT NULL DEFAULT 0,
        likes INTEGER NOT NULL DEFAULT 0,
        shares INTEGER NOT NULL DEFAULT 0,
        saves INTEGER NOT NULL DEFAULT 0,
        hides INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      -- A viewer's decaying affinity for a creator, a topic or a tag.
      CREATE TABLE IF NOT EXISTS user_affinity (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,              -- creator | topic | tag
        key TEXT NOT NULL,
        score REAL NOT NULL DEFAULT 0,   -- value as of updated_at; decays from there
        events INTEGER NOT NULL DEFAULT 0,
        positive INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, kind, key)
      );
    `,
  },
];

export function runMigrations(db, list = MIGRATIONS) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)");
  const done = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version));
  const ran = [];
  for (const m of [...list].sort((a, b) => a.version - b.version)) {
    if (done.has(m.version)) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(m.version, m.name, Date.now());
      db.exec("COMMIT");
      ran.push(m.version);
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return ran;
}
