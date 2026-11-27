// Engagement logging: the player sends batches of events; each is stored, then folded into
// the viewer's decaying creator / topic / tag affinities and the clip's global stats.
import { db, q, now as clock, transaction } from "./db.js";
import { RANKING } from "./rankingConfig.js";
import { clamp } from "./learner.js";
import { clipKeys, decayed, eventValue } from "./reelsRanker.js";
import { isPromoImpression } from "./promotions.js";

export const EVENT_TYPES = new Set(["view", "like", "unlike", "share", "copy_link", "save", "unsave", "hide"]);
export const MAX_BATCH = 50;

/** Clean one raw event from the client. Returns null when it can't be used. */
export function normalizeEvent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const type = String(raw.type || "");
  const impressionId = String(raw.impressionId || "").slice(0, 80);
  if (!EVENT_TYPES.has(type) || !impressionId) return null;
  const num = (x, hi) => clamp(Math.round(Number(x) || 0), 0, hi);
  const watchedMs = num(raw.watchedMs, 10 * 60e3);
  const durationMs = num(raw.durationMs, 60 * 60e3);
  const completion = Number.isFinite(Number(raw.completion)) ? clamp(Number(raw.completion), 0, 5)
    : durationMs > 0 ? clamp(watchedMs / durationMs, 0, 5) : 0;
  return {
    type, impressionId, watchedMs, durationMs, completion,
    rewatches: num(raw.rewatches, 50),
    quickSkip: raw.quickSkip === true || (type === "view" && raw.quickSkip !== false && watchedMs < RANKING.eventValue.quickSkipMs),
    clientTs: num(raw.ts, 8.64e15),
  };
}

/** Toggle pairs: an unlike only counts after a counted like, and vice versa. */
const TOGGLES = { like: ["like", "unlike"], unlike: ["like", "unlike"], save: ["save", "unsave"], unsave: ["save", "unsave"] };

/** Should this event change aggregates, or is it a repeat (double tap, retried batch)? */
function shouldApply(userId, evt) {
  const pair = TOGGLES[evt.type];
  if (pair) {
    const r = q.get(`SELECT SUM(CASE WHEN type = ? THEN 1 ELSE 0 END) AS on_, SUM(CASE WHEN type = ? THEN 1 ELSE 0 END) AS off
                     FROM engagement_events WHERE user_id = ? AND impression_id = ? AND applied = 1 AND type IN (?, ?)`,
      pair[0], pair[1], userId, evt.impressionId, pair[0], pair[1]);
    const active = (r?.on_ || 0) - (r?.off || 0) > 0;
    return evt.type === pair[0] ? !active : active;
  }
  return !q.get("SELECT 1 FROM engagement_events WHERE user_id = ? AND impression_id = ? AND type = ? AND applied = 1", userId, evt.impressionId, evt.type);
}

function bumpAffinity(userId, kind, key, delta, at) {
  if (!key || !delta) return;
  const row = q.get("SELECT score, updated_at FROM user_affinity WHERE user_id = ? AND kind = ? AND key = ?", userId, kind, key);
  const score = (row ? decayed(row.score, row.updated_at, at) : 0) + delta;
  q.run(`INSERT INTO user_affinity (user_id, kind, key, score, events, positive, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(user_id, kind, key) DO UPDATE SET score = excluded.score, events = events + 1,
           positive = positive + excluded.positive, updated_at = excluded.updated_at`,
    userId, kind, key, score, delta > 0 ? 1 : 0, at);
}

const STAT_COLUMNS = {
  like: ["likes", 1], unlike: ["likes", -1], save: ["saves", 1], unsave: ["saves", -1],
  share: ["shares", 1], copy_link: ["shares", 1], hide: ["hides", 1],
};

function bumpStats(videoId, evt, at) {
  q.run("INSERT OR IGNORE INTO clip_stats (video_id, updated_at) VALUES (?, ?)", videoId, at);
  if (evt.type === "view") {
    q.run(`UPDATE clip_stats SET views = views + 1, completion_sum = completion_sum + ?, quick_skips = quick_skips + ?,
           rewatches = rewatches + ?, updated_at = ? WHERE video_id = ?`,
      Math.min(1, evt.completion), evt.quickSkip ? 1 : 0, evt.rewatches, at, videoId);
    return;
  }
  const [col, d] = STAT_COLUMNS[evt.type] || [];
  if (col) q.run(`UPDATE clip_stats SET ${col} = MAX(0, ${col} + ?), updated_at = ? WHERE video_id = ?`, d, at, videoId);
}

/**
 * Record a batch of events for one viewer. Events naming an impression that isn't theirs are
 * dropped. Returns counts so the client (and tests) can see what happened.
 */
export function recordEngagement(userId, rawEvents, { now = clock() } = {}) {
  const list = Array.isArray(rawEvents) ? rawEvents.slice(0, MAX_BATCH) : [];
  let accepted = 0, applied = 0, rejected = 0;
  const impStmt = db.prepare("SELECT i.id, i.reason, v.id AS video_id, v.creator, v.tags_json FROM impressions i JOIN videos v ON v.id = i.video_id WHERE i.id = ? AND i.user_id = ?");
  const ins = db.prepare(`INSERT INTO engagement_events (user_id, video_id, impression_id, type, watched_ms, duration_ms, completion,
    rewatches, quick_skip, value, applied, client_ts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  transaction(() => {
    for (const raw of list) {
      const evt = normalizeEvent(raw);
      const imp = evt && impStmt.get(evt.impressionId, userId);
      if (!evt || !imp) { rejected++; continue; }
      accepted++;
      // A promoted clip was not picked for the viewer, so it says nothing about their taste.
      const apply = !isPromoImpression(imp) && shouldApply(userId, evt);
      const value = apply ? eventValue(evt) : 0;
      ins.run(userId, imp.video_id, evt.impressionId, evt.type, evt.watchedMs, evt.durationMs, evt.completion,
        evt.rewatches, evt.quickSkip ? 1 : 0, value, apply ? 1 : 0, evt.clientTs, now);
      if (!apply) continue;
      applied++;
      bumpStats(imp.video_id, evt, now);
      const keys = clipKeys(imp);
      bumpAffinity(userId, "creator", keys.creator, value, now);
      bumpAffinity(userId, "topic", keys.topic, value, now);
      for (const t of keys.tags) bumpAffinity(userId, "tag", t.key, value * t.relevance, now);
    }
  });
  return { accepted, applied, rejected };
}
