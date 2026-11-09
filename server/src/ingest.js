// Turns a user's discovery queries into catalog rows, then tags them with AI.
import { db, q, uid, now, transaction } from "./db.js";
import { SOURCES } from "./sources/index.js";
import { tagVideos } from "./ai/tagger.js";

const inflight = new Map(); // userId -> Promise, so a scroll burst triggers one run

export function saveQueries(userId, queries) {
  const ins = db.prepare(
    "INSERT OR IGNORE INTO discovery_queries (user_id, source, query, created_at) VALUES (?, ?, ?, ?)",
  );
  transaction(() => {
    for (const [source, list] of Object.entries(queries || {})) {
      if (!SOURCES[source]) continue;
      for (const query of list) ins.run(userId, source, query, now());
    }
  });
}

/** Upsert normalized items; returns the ids of rows that are new and untagged. */
export function upsertVideos(items) {
  const sel = db.prepare("SELECT id, tagged FROM videos WHERE source = ? AND external_id = ?");
  const ins = db.prepare(`INSERT INTO videos (id, source, external_id, embed_kind, url, title, creator, description, thumbnail, duration_ms, query, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const upd = db.prepare(`UPDATE videos SET title = CASE WHEN title = '' THEN ? ELSE title END,
    creator = CASE WHEN creator = '' THEN ? ELSE creator END, thumbnail = CASE WHEN thumbnail = '' THEN ? ELSE thumbnail END,
    duration_ms = CASE WHEN duration_ms = 0 THEN ? ELSE duration_ms END WHERE id = ?`);
  const fresh = [];
  transaction(() => {
    for (const it of items) {
      const row = sel.get(it.source, it.external_id);
      if (row) {
        upd.run(it.title, it.creator, it.thumbnail, it.duration_ms, row.id);
        if (!row.tagged) fresh.push(row.id);
        continue;
      }
      const id = uid();
      ins.run(id, it.source, it.external_id, it.embed_kind, it.url, it.title, it.creator, it.description, it.thumbnail, it.duration_ms, it.query || "", now());
      fresh.push(id);
    }
  });
  return fresh;
}

export async function tagPending(ids) {
  if (!ids.length) return;
  const rows = q.all(`SELECT id, source, title, creator, description, query FROM videos WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids);
  for (let i = 0; i < rows.length; i += 25) {
    const batch = rows.slice(i, i + 25);
    const tags = await tagVideos(batch);
    const upd = db.prepare("UPDATE videos SET tags_json = ?, tagged = 1 WHERE id = ?");
    transaction(() => {
      for (const v of batch) upd.run(JSON.stringify(tags.get(v.id) || []), v.id);
    });
  }
}

/**
 * Run the user's stale/new discovery queries across every source.
 * `limit` caps queries per run so the feed stays responsive.
 */
export function runDiscovery(userId, { limit = 6, staleMs = 6 * 3600e3 } = {}) {
  if (inflight.has(userId)) return inflight.get(userId);
  const p = (async () => {
    const rows = q.all(
      `SELECT id, source, query FROM discovery_queries WHERE user_id = ? AND (last_run_at IS NULL OR last_run_at < ?)
       ORDER BY last_run_at IS NOT NULL, created_at DESC LIMIT ?`,
      userId, now() - staleMs, limit,
    );
    let added = 0;
    for (const r of rows) {
      try {
        let items = await SOURCES[r.source].search(r.query, { max: 12 });
        if (SOURCES[r.source].enrich) items = await Promise.all(items.map((i) => SOURCES[r.source].enrich(i)));
        const fresh = upsertVideos(items);
        added += fresh.length;
        q.run("UPDATE discovery_queries SET last_run_at = ?, items_found = items_found + ? WHERE id = ?", now(), items.length, r.id);
        await tagPending(fresh);
      } catch (e) {
        console.warn(`[ingest] ${r.source} "${r.query}": ${e.message}`);
        q.run("UPDATE discovery_queries SET last_run_at = ? WHERE id = ?", now(), r.id);
      }
    }
    return added;
  })().finally(() => inflight.delete(userId));
  inflight.set(userId, p);
  return p;
}
