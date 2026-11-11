// Scores unseen catalog items for a user and assembles a diverse batch.
import { q } from "./db.js";
import { config } from "./config.js";
import { safeTags } from "./learner.js";

const R = config.ranking;

export function loadUserModel(userId) {
  const interests = new Map();
  for (const r of q.all("SELECT tag, weight, impressions FROM interests WHERE user_id = ?", userId)) interests.set(r.tag, r);
  const avoid = new Set(JSON.parse(q.get("SELECT avoid_json FROM profiles WHERE user_id = ?", userId)?.avoid_json || "[]"));
  const totalViews = q.get("SELECT COUNT(*) AS n FROM impressions WHERE user_id = ? AND finalized = 1", userId)?.n || 0;
  const sourceAff = new Map();
  for (const r of q.all("SELECT source, views, score_sum FROM source_affinity WHERE user_id = ?", userId)) {
    sourceAff.set(r.source, r.views ? r.score_sum / r.views : 0);
  }
  return { interests, avoid, totalViews, sourceAff, tokenIndex: buildTokenIndex(interests) };
}

// Interests and clip tags come from different AI calls, so "specialty-coffee" and "coffee"
// must still recognize each other. Index each interest by its meaningful words.
const STOP = new Set(["and", "the", "for", "with", "how", "to", "of", "in", "a", "shorts", "short", "video", "videos", "tutorial", "tips", "learning", "music", "food", "home", "diy"]);
const tokens = (tag) => tag.split("-").filter((t) => t.length > 2 && !STOP.has(t));
export function buildTokenIndex(interests) {
  const idx = new Map();
  for (const [tag, it] of interests) {
    for (const tok of tokens(tag)) {
      const cur = idx.get(tok);
      // Keep the strongest signal per word, by magnitude, so dislikes carry over too.
      if (!cur || Math.abs(it.weight) > Math.abs(cur.weight)) idx.set(tok, { tag, weight: it.weight, impressions: it.impressions });
    }
  }
  return idx;
}
const PARTIAL = 0.6; // a related-word match counts for 60% of an exact one
/** Exact interest for a clip tag, or the best related one by shared word. */
export function lookupInterest(tag, model) {
  const exact = model.interests.get(tag);
  if (exact) return { ...exact, tag, factor: 1 };
  if (!model.tokenIndex) return null;
  let best = null;
  for (const tok of tokens(tag)) {
    const hit = model.tokenIndex.get(tok);
    if (hit && (!best || Math.abs(hit.weight) > Math.abs(best.weight))) best = hit;
  }
  return best ? { ...best, factor: PARTIAL } : null;
}

/** Pure scoring function (exported for tests). */
export function scoreVideo(video, model, { rand = Math.random } = {}) {
  const tags = safeTags(video.tags_json);
  if (tags.some((t) => model.avoid.has(t.tag) || avoidsRelated(t.tag, model.avoid))) return null;
  let relSum = 0, match = 0, explore = 0;
  for (const { tag, relevance } of tags) {
    relSum += relevance;
    const it = lookupInterest(tag, model);
    if (it) match += it.weight * it.factor * relevance;
    // UCB-style bonus: tags the user has rarely been shown are worth testing.
    const n = it?.impressions || 0;
    explore += relevance * Math.sqrt(Math.log(model.totalViews + 2) / (n + 1));
  }
  const norm = Math.max(1, relSum);
  match /= norm;
  explore = (explore / norm) * R.exploreWeight;
  const ageDays = (Date.now() - video.created_at) / 86400e3;
  const freshness = Math.exp(-ageDays / 14) * R.freshnessWeight;
  const sourceBonus = 0.3 * (model.sourceAff.get(video.source) || 0);
  const noise = gumbel(rand) * R.noise;
  const explanation = topReason(tags, model);
  return { total: match + explore + freshness + sourceBonus + noise, match, explore, explanation };
}

/** Pick a batch with greedy diversity: penalize repeating the same tags/creators. */
export function rankBatch(candidates, model, size = R.batchSize, opts = {}) {
  const scored = [];
  for (const v of candidates) {
    const s = scoreVideo(v, model, opts);
    if (s) scored.push({ video: v, ...s });
  }
  scored.sort((a, b) => b.total - a.total);
  const picked = [];
  const seenTags = new Map();
  const seenCreators = new Map();
  while (picked.length < size && scored.length) {
    let bestIdx = 0, best = -Infinity;
    for (let i = 0; i < Math.min(scored.length, 60); i++) {
      const c = scored[i];
      const tags = safeTags(c.video.tags_json).slice(0, 3);
      let penalty = 0;
      for (const t of tags) penalty += (seenTags.get(t.tag) || 0) * R.diversityPenalty * t.relevance;
      if (c.video.creator) penalty += (seenCreators.get(c.video.creator) || 0) * R.diversityPenalty * 1.5;
      const adj = c.total - penalty;
      if (adj > best) { best = adj; bestIdx = i; }
    }
    const [chosen] = scored.splice(bestIdx, 1);
    for (const t of safeTags(chosen.video.tags_json).slice(0, 3)) seenTags.set(t.tag, (seenTags.get(t.tag) || 0) + 1);
    if (chosen.video.creator) seenCreators.set(chosen.video.creator, (seenCreators.get(chosen.video.creator) || 0) + 1);
    picked.push(chosen);
  }
  // Variable reward: occasionally slot a pure-exploration pick a few cards in.
  if (picked.length >= 4 && scored.length && Math.random() < 0.6) {
    scored.sort((a, b) => b.explore - a.explore);
    const wild = scored[0];
    wild.explanation = "Something new, to see if it lands";
    picked.splice(3, 0, wild);
    if (picked.length > size) picked.pop();
  }
  return picked;
}

export function unseenCandidates(userId, limit = 400) {
  return q.all(
    `SELECT v.* FROM videos v
     WHERE v.tagged = 1 AND v.id NOT IN (SELECT video_id FROM impressions WHERE user_id = ?)
     ORDER BY v.created_at DESC LIMIT ?`,
    userId, limit,
  );
}

const stem = (w) => w.replace(/s$/, "");
function avoidsRelated(tag, avoid) {
  if (!avoid.size) return false;
  const toks = new Set(tokens(tag).map(stem));
  for (const a of avoid) {
    const at = tokens(a).map(stem);
    if (at.length && at.every((x) => toks.has(x))) return true;
  }
  return false;
}

function topReason(tags, model) {
  let best = null;
  for (const t of tags) {
    const it = lookupInterest(t.tag, model);
    const s = it ? it.weight * it.factor * t.relevance : 0;
    if (s > 0 && (!best || s > best.s)) best = { tag: it.tag, s };
  }
  if (best) return `Because you watch ${best.tag.replace(/-/g, " ")}`;
  return tags[0] ? `Trying ${tags[0].tag.replace(/-/g, " ")}` : "Fresh pick";
}

function gumbel(rand) {
  const u = Math.min(1 - 1e-9, Math.max(1e-9, rand()));
  return -Math.log(-Math.log(u));
}
