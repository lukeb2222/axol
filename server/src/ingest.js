// Turns a user's discovery queries into catalog rows, then tags them with AI.
import { db, q, uid, now, transaction } from "./db.js";
import { SOURCES } from "./sources/index.js";
import { tagVideos } from "./ai/tagger.js";
import { config } from "./config.js";
import { TAXONOMY } from "./ai/taxonomy.js";

const normQuery = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();
let quotaExhaustedUntil = 0;
export const discoveryState = () => ({ quotaPausedUntil: quotaExhaustedUntil || null });

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
    // Only sources that can actually search count toward the limit; the rest are parked.
    const active = Object.values(SOURCES).filter((s) => s.canDiscover()).map((s) => s.name);
    if (!active.length) return 0;
    const rows = q.all(
      `SELECT id, source, query FROM discovery_queries WHERE user_id = ? AND source IN (${active.map(() => "?").join(",")})
         AND (last_run_at IS NULL OR last_run_at < ?)
       ORDER BY last_run_at IS NOT NULL, CASE source WHEN 'youtube' THEN 0 ELSE 1 END, created_at DESC LIMIT ?`,
      userId, ...active, now() - staleMs, limit,
    );
    let added = 0;
    for (const r of rows) {
      // Shared cache: if anyone ran this query recently, the catalog already has its results.
      const key = normQuery(r.query);
      const cached = q.get("SELECT last_run_at, items_found FROM query_runs WHERE source = ? AND query_norm = ?", r.source, key);
      if (cached && now() - cached.last_run_at < config.ranking.queryCacheMs) {
        q.run("UPDATE discovery_queries SET last_run_at = ?, items_found = ? WHERE id = ?", now(), cached.items_found, r.id);
        continue;
      }
      if (r.source === "youtube" && now() < quotaExhaustedUntil) continue;
      try {
        let items = await SOURCES[r.source].search(r.query, { max: 12 });
        if (SOURCES[r.source].enrich) items = await Promise.all(items.map((i) => SOURCES[r.source].enrich(i)));
        const fresh = upsertVideos(items);
        added += fresh.length;
        q.run("UPDATE discovery_queries SET last_run_at = ?, items_found = items_found + ? WHERE id = ?", now(), items.length, r.id);
        q.run("INSERT INTO query_runs (source, query_norm, last_run_at, items_found) VALUES (?, ?, ?, ?) ON CONFLICT(source, query_norm) DO UPDATE SET last_run_at = excluded.last_run_at, items_found = excluded.items_found", r.source, key, now(), items.length);
        await tagPending(fresh);
      } catch (e) {
        if (e.quota) { quotaExhaustedUntil = now() + 3600e3; console.warn("[ingest]", e.message); break; }
        console.warn(`[ingest] ${r.source} "${r.query}": ${e.message}`);
        q.run("UPDATE discovery_queries SET last_run_at = ? WHERE id = ?", now(), r.id);
      }
    }
    return added;
  })().finally(() => inflight.delete(userId));
  inflight.set(userId, p);
  return p;
}

/**
 * Pre-fill the shared catalog so a brand-new user never sees an empty feed.
 * Cheap first (trending per category, 1 unit each), then a bounded number of topic searches.
 * Safe to call on every boot: cached queries are skipped, and it stops at the daily budget.
 */
const YT_CATEGORIES = [
  [17, "sports"], [10, "music"], [23, "comedy"], [20, "gaming"], [15, "animals"], [24, "entertainment"],
  [26, "life-hacks"], [28, "science"], [19, "travel"], [2, "cars"], [1, "movies"], [22, "pov-storytelling"], [27, "education"],
];
export async function warmupCatalog({ maxSearches = 20 } = {}) {
  const yt = SOURCES.youtube;
  if (!yt.trending || yt.mode() !== "api") return 0;
  let added = 0;
  for (const [id, label] of YT_CATEGORIES) {
    const key = `trending:${label}`;
    const cached = q.get("SELECT last_run_at FROM query_runs WHERE source = 'youtube' AND query_norm = ?", key);
    if (cached && now() - cached.last_run_at < 6 * 3600e3) continue;
    try {
      const items = await yt.trending(id, label);
      const fresh = upsertVideos(items);
      added += fresh.length;
      q.run("INSERT INTO query_runs (source, query_norm, last_run_at, items_found) VALUES ('youtube', ?, ?, ?) ON CONFLICT(source, query_norm) DO UPDATE SET last_run_at = excluded.last_run_at, items_found = excluded.items_found", key, now(), items.length);
      await tagPending(fresh);
    } catch (e) {
      if (e.quota) { quotaExhaustedUntil = now() + 3600e3; console.warn("[warmup]", e.message); return added; }
      console.warn(`[warmup] trending ${label}: ${e.message}`);
    }
  }
  // Topic searches: rotate through the taxonomy, skipping anything searched in the last day.
  let searches = 0;
  const topics = Object.keys(TAXONOMY).sort(() => Math.random() - 0.5);
  for (const topic of topics) {
    if (searches >= maxSearches) break;
    const query = `${topic.replace(/-/g, " ")} shorts`;
    const key = normQuery(query);
    const cached = q.get("SELECT last_run_at FROM query_runs WHERE source = 'youtube' AND query_norm = ?", key);
    if (cached && now() - cached.last_run_at < config.ranking.queryCacheMs) continue;
    try {
      const items = await yt.search(query, { max: 25 });
      searches++;
      const fresh = upsertVideos(items);
      added += fresh.length;
      q.run("INSERT INTO query_runs (source, query_norm, last_run_at, items_found) VALUES ('youtube', ?, ?, ?) ON CONFLICT(source, query_norm) DO UPDATE SET last_run_at = excluded.last_run_at, items_found = excluded.items_found", key, now(), items.length);
      await tagPending(fresh);
    } catch (e) {
      if (e.quota) { quotaExhaustedUntil = now() + 3600e3; console.warn("[warmup]", e.message); break; }
      console.warn(`[warmup] "${query}": ${e.message}`);
    }
  }
  return added;
}
