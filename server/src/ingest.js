// Turns a user's discovery queries into catalog rows, then tags them with AI.
import { db, q, uid, now, transaction } from "./db.js";
import { SOURCES } from "./sources/index.js";
import { tagVideos } from "./ai/tagger.js";
import { cacheMany, mediaEnabled } from "./media.js";
import { apifyEnabled, apifyRunsToday, tiktokFiles } from "./sources/apify.js";
import { youtubeUnitsUsed } from "./sources/youtube.js";
import { config } from "./config.js";
import { TAXONOMY } from "./ai/taxonomy.js";

const normQuery = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();
let quotaExhaustedUntil = 0;
const pausedUntil = {}; // source -> timestamp
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
  const src = db.prepare("UPDATE videos SET media_src = ?, media_fails = 0 WHERE id = ? AND media_file = ''");
  const fresh = [], withMedia = [];
  transaction(() => {
    for (const it of items) {
      const row = sel.get(it.source, it.external_id);
      let id = row?.id;
      if (row) {
        upd.run(it.title, it.creator, it.thumbnail, it.duration_ms, row.id);
        if (!row.tagged) fresh.push(row.id);
      } else {
        id = uid();
        ins.run(id, it.source, it.external_id, it.embed_kind, it.url, it.title, it.creator, it.description, it.thumbnail, it.duration_ms, it.query || "", now());
        fresh.push(id);
      }
      if (it.media_src) { src.run(it.media_src, id); withMedia.push(id); }
    }
  });
  // Fetch the files right away (links to them can be short-lived); never blocks discovery.
  if (withMedia.length) cacheMany(withMedia).catch((e) => console.warn("[media]", e.message));
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
    // Each source that can search gets its own lane; lanes run concurrently so a slow
    // scraper never holds up YouTube, and no platform starves the others.
    const active = Object.values(SOURCES).filter((s) => s.canDiscover()).map((s) => s.name);
    if (!active.length) return 0;
    const perSource = (name) => (name === "youtube" ? limit : Math.max(1, Math.ceil(limit / 3)));
    const lanes = active.map(async (name) => {
      const rows = q.all(
        `SELECT id, source, query FROM discovery_queries WHERE user_id = ? AND source = ? AND (last_run_at IS NULL OR last_run_at < ?)
         ORDER BY last_run_at IS NOT NULL, created_at DESC LIMIT ?`,
        userId, name, now() - staleMs, perSource(name),
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
        if (now() < (pausedUntil[name] || 0)) break;
        try {
          let items = await SOURCES[name].search(r.query, { max: 12 });
          // Provider results already carry metadata; only enrich what is still bare.
          if (SOURCES[name].enrich) items = await Promise.all(items.map((i) => (i.title ? i : SOURCES[name].enrich(i))));
          const fresh = upsertVideos(items);
          added += fresh.length;
          q.run("UPDATE discovery_queries SET last_run_at = ?, items_found = items_found + ? WHERE id = ?", now(), items.length, r.id);
          q.run("INSERT INTO query_runs (source, query_norm, last_run_at, items_found) VALUES (?, ?, ?, ?) ON CONFLICT(source, query_norm) DO UPDATE SET last_run_at = excluded.last_run_at, items_found = excluded.items_found", r.source, key, now(), items.length);
          await tagPending(fresh);
        } catch (e) {
          if (e.quota) { pausedUntil[name] = now() + 3600e3; if (name === "youtube") quotaExhaustedUntil = pausedUntil[name]; console.warn("[ingest]", e.message); break; }
          console.warn(`[ingest] ${r.source} "${r.query}": ${e.message}`);
          q.run("UPDATE discovery_queries SET last_run_at = ? WHERE id = ?", now(), r.id);
        }
      }
      return added;
    });
    // The caller only waits for the fastest useful lane (YouTube); the rest finish in the background.
    const results = await Promise.allSettled(lanes);
    const added = results.reduce((n, r) => n + (r.status === "fulfilled" ? r.value : 0), 0);
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

/**
 * Discover one topic on every platform that can search, sharing the 24h query cache.
 * Resolves as soon as the fast lane (YouTube) is done or `waitMs` passes; slower provider
 * lanes keep running and land in the catalog on their own. Returns { started, pending }.
 */
const topicInflight = new Map();
export function discoverTopic(topic, { waitMs = 6000 } = {}) {
  const base = normQuery(topic);
  const plan = { youtube: `${base} shorts`, tiktok: base, instagram: base };
  const lanes = [];
  for (const s of Object.values(SOURCES)) {
    if (!s.canDiscover()) continue;
    const query = plan[s.name];
    const key = normQuery(query);
    const cached = q.get("SELECT last_run_at FROM query_runs WHERE source = ? AND query_norm = ?", s.name, key);
    if (cached && now() - cached.last_run_at < config.ranking.queryCacheMs) continue;
    if (budgetSpent(s.name)) continue;
    const id = `${s.name}:${key}`;
    if (!topicInflight.has(id)) {
      const p = (async () => {
        try {
          let items = await s.search(query, { max: 15 });
          if (s.enrich) items = await Promise.all(items.map((i) => (i.title ? i : s.enrich(i))));
          const fresh = upsertVideos(items);
          q.run("INSERT INTO query_runs (source, query_norm, last_run_at, items_found) VALUES (?, ?, ?, ?) ON CONFLICT(source, query_norm) DO UPDATE SET last_run_at = excluded.last_run_at, items_found = excluded.items_found", s.name, key, now(), items.length);
          await tagPending(fresh);
          return fresh.length;
        } catch (e) {
          if (e.quota) { pausedUntil[s.name] = now() + 3600e3; if (s.name === "youtube") quotaExhaustedUntil = pausedUntil[s.name]; }
          console.warn(`[search] ${s.name} "${query}": ${e.message}`);
          return 0;
        }
      })().finally(() => topicInflight.delete(id));
      topicInflight.set(id, p);
    }
    lanes.push({ name: s.name, promise: topicInflight.get(id) });
  }
  const fast = lanes.filter((l) => l.name === "youtube").map((l) => l.promise);
  const wait = Promise.race([Promise.allSettled(fast.length ? fast : lanes.map((l) => l.promise)), new Promise((r) => setTimeout(r, waitMs))]);
  return wait.then(() => ({ started: lanes.length, ...topicStatus(topic) }));
}

/** Has this platform's daily budget run out? Checked against the ledger, before trying anything. */
export function budgetSpent(name) {
  if (now() < (pausedUntil[name] || 0)) return true;
  if (name === "youtube") return youtubeUnitsUsed() + 101 > config.youtubeDailyUnits; // one search + one details call
  if (apifyEnabled() && (name === "tiktok" || name === "instagram")) return apifyRunsToday() >= config.apifyDailyRuns;
  return false;
}

/**
 * Where a fresh search for this topic stands on each platform that can search:
 *   pending   — running right now
 *   paused    — the platform's daily budget is spent; nothing will be attempted
 *   fresh     — already searched within the cache window, so there is nothing new to fetch
 *   available — could be searched now
 */
export function topicStatus(topic) {
  const base = normQuery(topic);
  const plan = { youtube: `${base} shorts`, tiktok: base, instagram: base };
  const names = Object.values(SOURCES).filter((s) => s.canDiscover()).map((s) => s.name);
  const pending = names.filter((n) => topicInflight.has(`${n}:${normQuery(plan[n])}`));
  const fresh = names.filter((n) => {
    const cached = q.get("SELECT last_run_at FROM query_runs WHERE source = ? AND query_norm = ?", n, normQuery(plan[n]));
    return cached && now() - cached.last_run_at < config.ranking.queryCacheMs;
  });
  const paused = names.filter((n) => !pending.includes(n) && !fresh.includes(n) && budgetSpent(n));
  const available = names.filter((n) => !pending.includes(n) && !fresh.includes(n) && !paused.includes(n));
  return { pending, paused, fresh, available };
}

/**
 * TikTok clips discovered before downloads were switched on have no file. Fetch files for a
 * batch of them in one provider run so they also play in axol's own player.
 */
export async function backfillTikTokFiles({ batch = 25 } = {}) {
  if (!apifyEnabled() || !config.apifyDownloadTikTok || !mediaEnabled()) return 0;
  const rows = q.all("SELECT id, external_id, url FROM videos WHERE source = 'tiktok' AND tagged = 1 AND media_src = '' AND media_fails < 3 ORDER BY created_at DESC LIMIT ?", batch);
  if (rows.length < 3) return 0;
  try {
    const files = await tiktokFiles(rows.map((r) => r.url));
    const set = db.prepare("UPDATE videos SET media_src = ? WHERE id = ?");
    const miss = db.prepare("UPDATE videos SET media_fails = media_fails + 1 WHERE id = ?");
    const ids = [];
    for (const r of rows) {
      const f = files.get(r.external_id);
      if (f) { set.run(f, r.id); ids.push(r.id); } else miss.run(r.id);
    }
    return await cacheMany(ids);
  } catch (e) {
    console.warn("[backfill]", e.message);
    return 0;
  }
}
