// Converts raw watch behaviour into an engagement score and nudges interest weights.
import { db, q, now, transaction } from "./db.js";
import { config } from "./config.js";

const L = config.learning;

/**
 * Engagement score for one impression. Roughly in [-1.5, 2].
 *   0 = neutral (watched ~45%), >0 = liked it, <0 = bounced.
 */
export function engagementScore(imp) {
  const duration = Math.max(imp.duration_ms || 0, 5000);
  const watched = Math.max(0, imp.watched_ms || 0);
  if (imp.hidden) return -1.5;
  // Loops count: watching 1.4x the length is a strong signal.
  const completion = Math.min(1.5, watched / duration);
  let score;
  if (watched < L.quickSkipMs && completion < 0.25) score = -1; // hard skip
  else score = clamp((completion - L.neutralCompletion) * 2, -1, 1.2);
  if (imp.liked) score += 0.6;
  if (imp.shared) score += 0.5;
  if (imp.replays > 0) score += 0.2 * Math.min(3, imp.replays);
  return clamp(score, -1.5, 2);
}

export function completionOf(imp) {
  const duration = Math.max(imp.duration_ms || 0, 5000);
  return Math.min(1.5, Math.max(0, imp.watched_ms || 0) / duration);
}

/**
 * Apply one finalized impression to the user's interest model.
 * Returns the per-tag deltas so the UI can show "the feed just learned ...".
 */
export function learnFromImpression(userId, imp, video) {
  const score = engagementScore(imp);
  const tags = safeTags(video.tags_json);
  const deltas = [];
  transaction(() => {
    // Gentle global decay so stale interests fade and the model stays plastic.
    db.prepare("UPDATE interests SET weight = weight * ? WHERE user_id = ?").run(L.decay, userId);

    const get = db.prepare("SELECT weight, impressions, positive FROM interests WHERE user_id = ? AND tag = ?");
    const upd = db.prepare("UPDATE interests SET weight = ?, impressions = impressions + 1, positive = positive + ?, updated_at = ? WHERE user_id = ? AND tag = ?");
    const ins = db.prepare("INSERT INTO interests (user_id, tag, weight, impressions, positive, origin, updated_at) VALUES (?, ?, ?, 1, ?, 'learned', ?)");

    const all = db.prepare("SELECT tag, weight FROM interests WHERE user_id = ?").all(userId);
    const words = (t) => t.split("-").filter((x) => x.length > 2);
    const related = (tag) => {
      const ws = new Set(words(tag));
      let best = null;
      for (const r of all) if (r.tag !== tag && words(r.tag).some((x) => ws.has(x)) && (!best || Math.abs(r.weight) > Math.abs(best.weight))) best = r;
      return best;
    };
    for (const { tag, relevance } of tags) {
      const row = get.get(userId, tag);
      const positive = score > 0.15 ? 1 : 0;
      if (row) {
        // Soft ceiling: the closer |w| is to maxWeight the smaller the step.
        const room = 1 - Math.min(1, Math.abs(row.weight) / L.maxWeight);
        const delta = L.rate * score * relevance * (0.35 + 0.65 * room);
        const w = clamp(row.weight + delta, -L.maxWeight, L.maxWeight);
        upd.run(w, positive, now(), userId, tag);
        deltas.push({ tag, delta: w - row.weight, weight: w });
      } else if (related(tag)) {
        // No exact interest, but a related one shares a word: train that one at reduced strength.
        const rel = related(tag);
        const room = 1 - Math.min(1, Math.abs(rel.weight) / L.maxWeight);
        const delta = L.rate * score * relevance * 0.6 * (0.35 + 0.65 * room);
        const w = clamp(rel.weight + delta, -L.maxWeight, L.maxWeight);
        upd.run(w, positive, now(), userId, rel.tag);
        rel.weight = w;
        deltas.push({ tag: rel.tag, delta, weight: w });
      } else if (score > 0.3 && relevance >= 0.5) {
        // Only adopt brand-new tags when the clip clearly landed.
        const w = L.rate * score * relevance;
        ins.run(userId, tag, w, positive, now());
        deltas.push({ tag, delta: w, weight: w, isNew: true });
      }
    }

    db.prepare(`INSERT INTO source_affinity (user_id, source, views, score_sum) VALUES (?, ?, 1, ?)
      ON CONFLICT(user_id, source) DO UPDATE SET views = views + 1, score_sum = score_sum + excluded.score_sum`)
      .run(userId, video.source, score);

    db.prepare("UPDATE impressions SET score = ?, finalized = 1, updated_at = ? WHERE id = ?").run(score, now(), imp.id);
    db.prepare("UPDATE profiles SET events_since_synth = events_since_synth + 1 WHERE user_id = ?").run(userId);
  });
  deltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return { score, deltas };
}

export function safeTags(json) {
  try {
    const t = JSON.parse(json || "[]");
    return Array.isArray(t) ? t.filter((x) => x && x.tag) : [];
  } catch {
    return [];
  }
}

export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
