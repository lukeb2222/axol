// Orchestrates onboarding and periodic re-synthesis of the user's taste profile.
import { db, q, now, transaction } from "./db.js";
import { config } from "./config.js";
import { buildInitialProfile, resynthesize } from "./ai/profile.js";
import { saveQueries, runDiscovery } from "./ingest.js";
import { safeTags, completionOf, clamp } from "./learner.js";

const W_SCALE = 2.5; // onboarding weight (0-1) -> internal weight

export async function onboard(userId, { text, chips }) {
  const p = await buildInitialProfile({ text, chips });
  const avoid = new Set(p.avoid);
  transaction(() => {
    db.prepare("DELETE FROM interests WHERE user_id = ?").run(userId);
    const ins = db.prepare("INSERT OR REPLACE INTO interests (user_id, tag, weight, impressions, positive, origin, updated_at) VALUES (?, ?, ?, 0, 0, ?, ?)");
    for (const i of p.interests) if (!avoid.has(i.tag)) ins.run(userId, i.tag, i.weight * W_SCALE, "onboarding", now());
    for (const i of p.adjacent) if (!avoid.has(i.tag)) ins.run(userId, i.tag, i.weight * W_SCALE * 0.6, "ai", now());
    db.prepare(`INSERT INTO profiles (user_id, raw_text, chips_json, summary, avoid_json, onboarded, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(user_id) DO UPDATE SET raw_text = excluded.raw_text, chips_json = excluded.chips_json, summary = excluded.summary,
      avoid_json = excluded.avoid_json, onboarded = 1, updated_at = excluded.updated_at`)
      .run(userId, text, JSON.stringify(chips), p.summary, JSON.stringify([...avoid]), now());
    db.prepare("INSERT INTO synth_log (user_id, summary, changes_json, mode, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(userId, p.summary, JSON.stringify({ interests: p.interests, adjacent: p.adjacent }), p.mode, now());
  });
  saveQueries(userId, p.queries);
  // Kick off discovery; the first feed request awaits it if the pool is empty.
  runDiscovery(userId, { limit: 10 }).catch((e) => console.warn("[discovery]", e.message));
  return getProfile(userId);
}

export function getProfile(userId) {
  const prof = q.get("SELECT * FROM profiles WHERE user_id = ?", userId);
  const interests = q.all("SELECT tag, weight, impressions, positive, origin, updated_at FROM interests WHERE user_id = ? ORDER BY weight DESC", userId);
  const stats = q.get(
    `SELECT COUNT(*) AS views, COALESCE(SUM(watched_ms),0) AS watched_ms, COALESCE(AVG(CASE WHEN finalized THEN score END),0) AS avg_score,
            SUM(liked) AS likes FROM impressions WHERE user_id = ?`, userId,
  );
  const sources = q.all("SELECT source, views, score_sum FROM source_affinity WHERE user_id = ?", userId)
    .map((s) => ({ source: s.source, views: s.views, affinity: s.views ? s.score_sum / s.views : 0 }));
  const log = q.all("SELECT summary, changes_json, mode, created_at FROM synth_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 10", userId)
    .map((l) => ({ ...l, changes: JSON.parse(l.changes_json), changes_json: undefined }));
  return {
    onboarded: !!prof?.onboarded,
    summary: prof?.summary || "",
    rawText: prof?.raw_text || "",
    chips: JSON.parse(prof?.chips_json || "[]"),
    avoid: JSON.parse(prof?.avoid_json || "[]"),
    eventsSinceSynth: prof?.events_since_synth || 0,
    synthCount: prof?.synth_count || 0,
    interests,
    stats,
    sources,
    log,
  };
}

/** Re-synthesize when enough new behaviour has accumulated (or when forced). */
export async function maybeResynthesize(userId, { force = false } = {}) {
  const prof = q.get("SELECT events_since_synth, summary FROM profiles WHERE user_id = ?", userId);
  if (!prof) return null;
  if (!force && prof.events_since_synth < config.learning.resynthEvery) return null;

  const interests = q.all("SELECT tag, weight, impressions, positive FROM interests WHERE user_id = ? ORDER BY weight DESC", userId);
  const recent = q.all(
    `SELECT i.*, v.title, v.source, v.tags_json FROM impressions i JOIN videos v ON v.id = i.video_id
     WHERE i.user_id = ? AND i.finalized = 1 ORDER BY i.updated_at DESC LIMIT 40`, userId,
  ).reverse().map((r) => ({
    source: r.source, title: r.title || "(untitled)", tags: safeTags(r.tags_json).map((t) => t.tag),
    completion: completionOf(r), liked: !!r.liked, replays: r.replays, skipped: !!r.skipped, hidden: !!r.hidden,
  }));

  const res = await resynthesize({ interests, recent, summary: prof.summary });
  transaction(() => {
    const get = db.prepare("SELECT weight FROM interests WHERE user_id = ? AND tag = ?");
    const upd = db.prepare("UPDATE interests SET weight = ?, updated_at = ? WHERE user_id = ? AND tag = ?");
    const ins = db.prepare("INSERT OR IGNORE INTO interests (user_id, tag, weight, impressions, positive, origin, updated_at) VALUES (?, ?, ?, 0, 0, 'ai', ?)");
    for (const a of res.adjustments) {
      const row = get.get(userId, a.tag);
      if (row) upd.run(clamp(row.weight + a.delta * 1.5, -config.learning.maxWeight, config.learning.maxWeight), now(), userId, a.tag);
      else if (a.delta > 0) ins.run(userId, a.tag, a.delta * 1.5, now());
    }
    for (const i of res.newInterests) ins.run(userId, i.tag, i.weight * W_SCALE * 0.5, now());
    db.prepare("UPDATE profiles SET summary = CASE WHEN ? = '' THEN summary ELSE ? END, events_since_synth = 0, synth_count = synth_count + 1, updated_at = ? WHERE user_id = ?")
      .run(res.summary, res.summary, now(), userId);
    db.prepare("INSERT INTO synth_log (user_id, summary, changes_json, mode, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(userId, res.insight, JSON.stringify({ adjustments: res.adjustments, newInterests: res.newInterests }), res.mode, now());
  });
  saveQueries(userId, res.queries);
  runDiscovery(userId, { limit: 6, staleMs: 0 }).catch((e) => console.warn("[discovery]", e.message));
  return { insight: res.insight, summary: res.summary, mode: res.mode, adjustments: res.adjustments, newInterests: res.newInterests };
}
