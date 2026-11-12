// Scores unseen catalog items for a user and assembles a diverse batch.
import { q } from "./db.js";
import { config } from "./config.js";
import { safeTags } from "./learner.js";
import { topicKey, contentWords, relate, isAbout, isFormatTag, prettyTopic, prettyShared, steerableTopics } from "./topics.js";

const R = config.ranking;
const MAXW = config.learning.maxWeight;

export function loadUserModel(userId) {
  const rows = q.all("SELECT tag, weight, impressions, positive, origin FROM interests WHERE user_id = ?", userId);
  const avoid = JSON.parse(q.get("SELECT avoid_json FROM profiles WHERE user_id = ?", userId)?.avoid_json || "[]");
  const totalViews = q.get("SELECT COUNT(*) AS n FROM impressions WHERE user_id = ? AND finalized = 1", userId)?.n || 0;
  const sourceAff = new Map();
  for (const r of q.all("SELECT source, views, score_sum FROM source_affinity WHERE user_id = ?", userId)) {
    sourceAff.set(r.source, r.views ? r.score_sum / r.views : 0);
  }
  return buildModel({ interests: rows, avoid, totalViews, sourceAff });
}

const ORIGIN_RANK = { onboarding: 4, search: 3, asked: 3, learned: 2, ai: 1 };

/**
 * Build the in-memory model the ranker scores against (exported so tests can make one directly).
 * Interest rows that name the same topic ("motocross-big-air", "big-air-motocross") are merged
 * into one entry, so they count once and are explained under one name.
 */
export function buildModel({ interests = [], avoid = [], totalViews = 0, sourceAff = new Map() } = {}) {
  const byKey = new Map();
  for (const r of interests) {
    const key = topicKey(r.tag);
    if (!key) continue;
    const cur = byKey.get(key);
    if (!cur) { byKey.set(key, { key, tag: r.tag, weight: r.weight, impressions: r.impressions || 0, positive: r.positive || 0, origin: r.origin || "learned", top: Math.abs(r.weight) }); continue; }
    cur.weight = Math.max(-MAXW, Math.min(MAXW, cur.weight + r.weight));
    cur.impressions += r.impressions || 0;
    cur.positive += r.positive || 0;
    if ((ORIGIN_RANK[r.origin] || 0) > (ORIGIN_RANK[cur.origin] || 0)) cur.origin = r.origin;
    if (Math.abs(r.weight) > cur.top) { cur.top = Math.abs(r.weight); cur.tag = r.tag; } // name it after its strongest row
  }
  // Subject word -> interests containing it, for finding genuinely related topics.
  const byWord = new Map();
  for (const it of byKey.values()) for (const w of contentWords(it.tag)) (byWord.get(w) || byWord.set(w, []).get(w)).push(it);
  return { interests: byKey, byWord, avoid: [...new Set(avoid)], avoidKeys: new Set(avoid.map(topicKey)), totalViews, sourceAff };
}

const PARTIAL = 0.6; // a related topic counts for at most 60% of the same topic

/**
 * The viewer interest a clip tag connects to, if any.
 *   - the same topic (after canonicalization) at full strength, or
 *   - the strongest interest sharing a SUBJECT word with it, scaled by how much they overlap.
 * Format words never connect two topics: "coffee-pov" does not match "motocross-rider-pov".
 */
export function lookupInterest(tag, model) {
  const exact = model.interests.get(topicKey(tag));
  if (exact) return { interest: exact, kind: "same", factor: 1, shared: contentWords(tag).length ? contentWords(tag) : null };
  let best = null;
  const seen = new Set();
  for (const w of contentWords(tag)) {
    for (const it of model.byWord.get(w) || []) {
      if (seen.has(it.key)) continue;
      seen.add(it.key);
      const rel = relate(it.tag, tag);
      if (!rel) continue;
      const factor = PARTIAL * rel.strength;
      if (!best || Math.abs(it.weight * factor) > Math.abs(best.interest.weight * best.factor)) best = { interest: it, kind: "related", factor, shared: rel.shared, strength: rel.strength };
    }
  }
  return best;
}

/** True when the viewer has muted this clip's subject. */
export function isAvoided(tags, model) {
  if (!model.avoid.length) return false;
  return tags.some((t) => model.avoidKeys.has(topicKey(t.tag)) || model.avoid.some((a) => isAbout(t.tag, a)));
}

/** Pure scoring function (exported for tests). */
export function scoreVideo(video, model, { rand = Math.random } = {}) {
  const tags = safeTags(video.tags_json);
  if (isAvoided(tags, model)) return null;
  let relSum = 0, match = 0, explore = 0;
  const links = [];
  for (const { tag, relevance } of tags) {
    relSum += relevance;
    const hit = lookupInterest(tag, model);
    if (hit) {
      const value = hit.interest.weight * hit.factor * relevance;
      match += value;
      links.push({ ...hit, clipTag: tag, relevance, value });
    }
    // UCB-style bonus: tags the user has rarely been shown are worth testing.
    const n = hit?.interest.impressions || 0;
    explore += relevance * Math.sqrt(Math.log(model.totalViews + 2) / (n + 1));
  }
  const norm = Math.max(1, relSum);
  match /= norm;
  for (const l of links) l.value /= norm;
  explore = (explore / norm) * R.exploreWeight;
  const ageDays = (Date.now() - video.created_at) / 86400e3;
  const freshness = Math.exp(-ageDays / 14) * R.freshnessWeight;
  const sourceBonus = 0.3 * (model.sourceAff.get(video.source) || 0);
  const noise = gumbel(rand) * R.noise;
  // A clip axol holds the file for starts instantly and always plays; an embed may not.
  const instant = video.media_file ? R.instantBonus : 0;
  const why = explain({ tags, links, match, explore });
  return { total: match + explore + freshness + sourceBonus + noise + instant, match, explore, why, explanation: why.label };
}

export const DISCOVERY_LABEL = "Something new, to see if it lands";

/**
 * Why was THIS clip picked? Built from the terms that actually produced its score, so the label
 * can only claim a connection that exists on both sides:
 *   - the viewer's side: an interest they have really watched (or explicitly asked for), and
 *   - the clip's side: a tag, relevant to the clip, that is that topic or contains it.
 * Anything weaker is a discovery pick and says so.
 */
export function explain({ tags, links, match, explore }) {
  const clipTopics = steerableTopics(tags).map((t) => t.label);
  const discovery = (detail) => ({ kind: "discovery", label: DISCOVERY_LABEL, topic: null, detail, clipTopics });
  // Several of a clip's tags often point at the same interest ("climbing", "bouldering" and
  // "climbing-gym" all at "rock-climbing"). Their pull is added up per interest; the strongest
  // single tag within the winning interest is the one the explanation names.
  const perInterest = new Map();
  for (const l of links) {
    const g = perInterest.get(l.interest.key) || { sum: 0, best: null };
    g.sum += l.value;
    const supports = l.relevance >= 0.5 && (l.kind === "same" || l.strength >= 1);
    const bestSupports = g.best && g.best.relevance >= 0.5 && (g.best.kind === "same" || g.best.strength >= 1);
    if (l.value > 0 && (!g.best || (supports && !bestSupports) || (supports === bestSupports && l.value > g.best.value))) g.best = l;
    perInterest.set(l.interest.key, g);
  }
  const winner = [...perInterest.values()].filter((g) => g.sum > 0 && g.best).sort((a, b) => b.sum - a.sum)[0];
  if (!winner) return discovery("This is a test pick. Nothing you've watched so far points to it.");
  const top = winner.best;

  const it = top.interest;
  // What the two sides have in common, in words: the topic itself, or the overlap.
  const topic = top.kind === "same" ? prettyTopic(it.tag) : prettyShared(top.shared, it.tag, top.clipTag);
  const clipSupports = top.relevance >= 0.5 && (top.kind === "same" || top.strength >= 1) && !isFormatOnly(top);
  const drivesTheScore = match >= R.explainMinMatch && winner.sum >= match * 0.5 && match >= explore * 0.5;
  if (!clipSupports || !drivesTheScore) {
    return discovery(`This is a test pick. It is only loosely connected to ${prettyTopic(it.tag)}, so axol is checking whether it lands.`);
  }
  const tagged = `this clip is about ${prettyTopic(top.clipTag)}`;
  if (it.positive >= 1) {
    const n = it.positive;
    return { kind: "watch", label: `Because you watch ${topic}`, topic: it.tag, clipTopics,
      detail: `You've watched ${n} ${topic} clip${n === 1 ? "" : "s"} most of the way through, and ${tagged}.` };
  }
  if (it.origin === "onboarding" || it.origin === "search" || it.origin === "asked") {
    const source = it.origin === "onboarding" ? "in your intro" : it.origin === "search" ? "by searching for it" : "with a More tap";
    return { kind: "asked", label: `Because you asked for ${topic}`, topic: it.tag, clipTopics,
      detail: `You told axol you want ${topic} ${source}, and ${tagged}. You haven't watched one through yet.` };
  }
  // An interest axol guessed and the viewer has never confirmed is not "because you watch".
  return discovery(`axol guessed you might like ${topic}. Nothing you've watched confirms that yet, so this is a test.`);
}
const isFormatOnly = (link) => link.kind === "same" && isFormatTag(link.clipTag) && link.interest.positive < 2;

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
  if (opts.wild !== false && picked.length >= 4 && scored.length && Math.random() < 0.6) {
    scored.sort((a, b) => b.explore - a.explore);
    const wild = scored[0];
    wild.why = { kind: "discovery", label: DISCOVERY_LABEL, topic: null, clipTopics: wild.why.clipTopics,
      detail: "This is a test pick, chosen because you've seen little like it. How long you watch tells axol whether to show more." };
    wild.explanation = wild.why.label;
    picked.splice(3, 0, wild);
    if (picked.length > size) picked.pop();
  }
  return picked;
}

// YouTube plays through its player API, which is dependable. TikTok and Instagram embeds are not
// (rate limits, tap-to-play, layouts that change per clip), so their clips are served only once
// axol holds the file and can play it in its own player.
export const PLAYABLE = "(v.source = 'youtube' OR v.media_file != '')";

export function unseenCandidates(userId, limit = 400) {
  return q.all(
    `SELECT v.* FROM videos v
     WHERE v.tagged = 1 AND ${PLAYABLE} AND v.id NOT IN (
       SELECT video_id FROM impressions WHERE user_id = ? AND (finalized = 1 OR watched_ms > 0 OR served_at > ?))
     ORDER BY v.created_at DESC LIMIT ?`,
    userId, Date.now() - 30 * 60e3, limit,
  );
}

function gumbel(rand) {
  const u = Math.min(1 - 1e-9, Math.max(1e-9, rand()));
  return -Math.log(-Math.log(u));
}
