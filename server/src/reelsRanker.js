// Reels-style personalized ranking for the main feed.
//
// Modelled on what Instagram has said publicly about Reels and Explore (sources in
// docs/ranking.md): predict how much this viewer will engage with each candidate clip, add a
// global quality signal and freshness, take off for clips already shown, then re-rank for
// diversity and reserve a few slots for exploration.
//
// Everything that decides an order is a pure function of its inputs (plus an injectable RNG),
// so it can be tested deterministically. Only loadSignals() and rankForUser() touch the database.
import { q } from "./db.js";
import { RANKING } from "./rankingConfig.js";
import { safeTags, clamp } from "./learner.js";
import { scoreVideo, loadUserModel, DISCOVERY_LABEL } from "./ranker.js";
import { topicKey, steerableTopics } from "./topics.js";

const DAY = 86400e3;

/* --------------------------------------- helpers --------------------------------------- */

/** Seeded PRNG (mulberry32). Same seed, same sequence. */
export function seededRng(seed = 1) {
  let a = (Number(seed) >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Exponential decay: what `score`, last updated at `updatedAt`, is worth at `at`. */
export function decayed(score, updatedAt, at = Date.now(), halfLifeDays = RANKING.affinity.halfLifeDays) {
  const ageDays = Math.max(0, (at - (updatedAt || at)) / DAY);
  return score * Math.pow(0.5, ageDays / halfLifeDays);
}

/** The keys a clip trains and is scored on: its creator, main topic and top tags. */
export function clipKeys(video, cfg = RANKING) {
  const tags = safeTags(video.tags_json).slice().sort((a, b) => (b.relevance ?? 1) - (a.relevance ?? 1));
  const main = steerableTopics(tags, { max: 1, minRelevance: 0 })[0]?.tag || tags[0]?.tag || "";
  return {
    creator: (video.creator || "").trim().toLowerCase(),
    topic: main ? topicKey(main) : "",
    tags: tags.slice(0, cfg.affinity.tagsPerClip).map((t) => ({ key: topicKey(t.tag), relevance: t.relevance ?? 1 })).filter((t) => t.key),
  };
}

/* ------------------------------------ event values ------------------------------------- */

/**
 * What one engagement event says about the viewer's taste for that clip, as a signed number.
 * A "view" carries watch time, completion, rewatches and whether it was a quick skip.
 */
export function eventValue(evt, cfg = RANKING) {
  const V = cfg.eventValue;
  switch (evt.type) {
    case "view": {
      const quick = evt.quickSkip ?? ((evt.watchedMs ?? 0) < V.quickSkipMs);
      if (quick) return V.quickSkip;
      const completion = clamp(evt.completion ?? 0, 0, 1);
      const rewatches = Math.min(V.maxRewatches, Math.max(0, evt.rewatches || 0));
      return V.watch * (completion - V.neutralCompletion) + V.rewatch * rewatches;
    }
    case "like": return V.like;
    case "unlike": return -V.like;
    case "save": return V.save;
    case "unsave": return -V.save;
    case "share": return V.share;
    case "copy_link": return V.copyLink;
    case "hide": return V.hide;
    default: return 0;
  }
}

/* --------------------------------------- scoring --------------------------------------- */

/** Bayesian-smoothed engagement rates for a clip, and one quality number built from them. */
export function clipQuality(stats, cfg = RANKING) {
  const Q = cfg.quality;
  const views = stats?.views || 0;
  const k = Q.priorViews;
  const rate = (sum, prior) => (sum + prior * k) / (views + k);
  const rates = {
    completion: rate(stats?.completion_sum || 0, Q.prior.completion),
    like: rate(stats?.likes || 0, Q.prior.like),
    share: rate(stats?.shares || 0, Q.prior.share),
    save: rate(stats?.saves || 0, Q.prior.save),
    quickSkip: rate(stats?.quick_skips || 0, Q.prior.quickSkip),
    hide: rate(stats?.hides || 0, Q.prior.hide),
  };
  // Weighted average of each rate's lift over its prior, so quality stays roughly in -1..2.
  let sum = 0, norm = 0;
  for (const [name, w] of Object.entries(Q.weights)) {
    sum += w * clamp((rates[name] - Q.prior[name]) / Q.prior[name], -1, Q.maxLift);
    norm += Math.abs(w);
  }
  return { views, rates, quality: norm ? sum / norm : 0 };
}

/** Popularity for cold start: how much a clip has been watched, scaled by how well it did. */
export function popularity(stats, cfg = RANKING) {
  const { views, quality } = clipQuality(stats, cfg);
  return Math.log1p(views) / Math.log1p(100) * (1 + clamp(quality, -1, 2)) / 2;
}

const squash = (x, cfg) => Math.tanh(x / cfg.affinity.scale);

/**
 * Score one candidate for one viewer. `user` = { affinity: Map("kind:key" -> {score, positive}),
 * events, interest: (video) -> {match, why} | null }. Returns null for clips the viewer muted.
 */
export function scoreCandidate(video, user, ctx = {}, cfg = RANKING) {
  const W = cfg.weights;
  const at = ctx.now ?? Date.now();
  const rand = ctx.rand || Math.random;
  const interest = user.interest ? user.interest(video) : { match: 0, why: null };
  if (interest === null) return null; // muted topic
  const keys = clipKeys(video, cfg);
  const aff = (kind, key) => (key ? user.affinity.get(`${kind}:${key}`) : null);
  const creatorA = aff("creator", keys.creator);
  const topicA = aff("topic", keys.topic);
  let tagSum = 0, relSum = 0;
  for (const t of keys.tags) { tagSum += squash(aff("tag", t.key)?.score || 0, cfg) * t.relevance; relSum += t.relevance; }

  // Personalization fades in over the first coldStart.events events; popularity fades out.
  const warm = clamp((user.events || 0) / cfg.coldStart.events, 0, 1);
  const stats = ctx.stats?.get(video.id);
  const { quality } = clipQuality(stats, cfg);
  const parts = {
    creator: warm * W.creatorAffinity * squash(creatorA?.score || 0, cfg),
    topic: warm * W.topicAffinity * squash(topicA?.score || 0, cfg),
    tags: warm * W.tagAffinity * (relSum ? tagSum / relSum : 0),
    interest: W.statedInterest * clamp(interest.match || 0, -2, 2),
    quality: W.quality * quality,
    popularity: (1 - warm) * cfg.coldStart.popularity * popularity(stats, cfg),
    freshness: W.freshness * Math.pow(0.5, Math.max(0, (at - (video.created_at || at)) / DAY) / cfg.freshnessHalfLifeDays),
    seen: -W.seenPenalty * (ctx.seen?.get(video.id) || 0),
    instant: video.media_file ? W.instant : 0,
    noise: W.noise * (rand() - 0.5),
  };
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  const isNew = !creatorA && !topicA && !keys.tags.some((t) => aff("tag", t.key));
  const underExposed = (stats?.views || 0) < cfg.exploration.underExposedViews;
  return { video, total, parts, keys, isNew, underExposed, why: interest.why, creatorAffinity: creatorA };
}

/* ------------------------------------ re-ranking --------------------------------------- */

/** How many items at the end of `list` share `key`'s value. */
function runLength(list, get, value) {
  if (!value) return 0;
  let n = 0;
  for (let i = list.length - 1; i >= 0 && get(list[i]) === value; i--) n++;
  return n;
}

/** Would appending `item` to `picked` break the no-long-runs rule? */
export function breaksRun(picked, item, { maxSameCreatorInRow, maxSameTopicInRow }) {
  return runLength(picked, (x) => x.keys.creator, item.keys.creator) >= maxSameCreatorInRow
    || runLength(picked, (x) => x.keys.topic, item.keys.topic) >= maxSameTopicInRow;
}

/**
 * Greedy diversity re-rank: walk the score order, and whenever the next-best clip would make
 * a run longer than allowed, take the best clip within `window` that doesn't. If nothing
 * qualifies the best clip goes in anyway (a thin catalog shouldn't empty the feed).
 */
export function diversify(scored, size, rules = RANKING.diversity, startWith = []) {
  const pool = [...scored].sort((a, b) => b.total - a.total);
  const picked = [...startWith];
  const out = [];
  while (out.length < size && pool.length) {
    let idx = pool.findIndex((c, i) => i < (rules.window || 60) && !breaksRun(picked, c, rules));
    if (idx < 0) idx = 0;
    const [c] = pool.splice(idx, 1);
    picked.push(c); out.push(c);
  }
  return out;
}

/** Positions (0-based) that become exploration slots in a batch of `size`. Deterministic per rng. */
export function explorationSlots(size, rng, cfg = RANKING) {
  const E = cfg.exploration;
  const max = Math.floor(size * E.maxShare);
  const slots = [];
  for (let i = E.firstSlot; i < size && slots.length < max; i++) if (rng() < E.rate) slots.push(i);
  return slots;
}

/**
 * Final batch: the exploitation list from diversify(), with exploration picks dropped into the
 * slots explorationSlots() chose. Exploration candidates are clips new to the viewer or seen by
 * few people, picked at random (weighted toward better scores) and still subject to the
 * no-long-runs rule.
 */
export function assembleBatch(scored, size, { rng = Math.random, rules = RANKING.diversity, cfg = RANKING } = {}) {
  const slots = new Set(explorationSlots(size, rng, cfg));
  const explorePool = scored.filter((c) => c.isNew || c.underExposed);
  const exploreIds = new Set();
  const picked = [];
  let rest = [...scored];
  for (let pos = 0; pos < size && (rest.length || explorePool.length); pos++) {
    let choice = null;
    if (slots.has(pos)) {
      const options = explorePool.filter((c) => !exploreIds.has(c.video.id) && rest.includes(c) && !breaksRun(picked, c, rules));
      if (options.length) {
        // Rank-weighted random pick: better-scoring exploration clips are likelier.
        options.sort((a, b) => b.total - a.total);
        const weights = options.map((_, i) => 1 / (i + 1));
        let r = rng() * weights.reduce((a, b) => a + b, 0);
        let i = 0;
        while (i < options.length - 1 && (r -= weights[i]) > 0) i++;
        choice = { ...options[i], explored: true };
        exploreIds.add(choice.video.id);
      }
    }
    if (!choice) {
      const [next] = diversify(rest, 1, rules, picked);
      if (!next) break;
      choice = next;
    }
    picked.push(choice);
    rest = rest.filter((c) => c.video.id !== choice.video.id);
  }
  return picked;
}

/* ------------------------------------ explanations ------------------------------------- */

/** Truthful "why am I seeing this" label for a ranked clip. */
export function explainPick(c) {
  const base = c.why || { kind: "discovery", label: DISCOVERY_LABEL, topic: null, clipTopics: [], detail: "" };
  if (c.explored) {
    return { ...base, kind: "discovery", label: DISCOVERY_LABEL, topic: null,
      detail: "This is a test pick: something you haven't seen much of. How long you watch tells axol whether to show more." };
  }
  // Creator affinity is the biggest single reason, and it comes from real positive engagement.
  const a = c.creatorAffinity;
  const biggest = Object.entries(c.parts).sort((x, y) => y[1] - x[1])[0]?.[0];
  if (base.kind === "discovery" && a && a.positive >= 2 && biggest === "creator" && c.video.creator) {
    return { ...base, kind: "creator", label: `Because you watch ${c.video.creator}`, topic: null,
      detail: `You've enjoyed ${a.positive} clips from ${c.video.creator} recently.` };
  }
  return base;
}

/* ---------------------------------------- data ----------------------------------------- */

/** Everything the scorer needs about a viewer and a candidate set, read in four queries. */
export function loadSignals(userId, candidates, at = Date.now(), cfg = RANKING) {
  const affinity = new Map();
  for (const r of q.all("SELECT kind, key, score, positive, updated_at FROM user_affinity WHERE user_id = ?", userId)) {
    affinity.set(`${r.kind}:${r.key}`, { score: decayed(r.score, r.updated_at, at, cfg.affinity.halfLifeDays), positive: r.positive });
  }
  const events = q.get("SELECT COUNT(*) AS n FROM engagement_events WHERE user_id = ? AND applied = 1", userId)?.n || 0;
  const ids = candidates.map((v) => v.id);
  const stats = new Map();
  const seen = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const marks = chunk.map(() => "?").join(",");
    if (!chunk.length) continue;
    for (const r of q.all(`SELECT * FROM clip_stats WHERE video_id IN (${marks})`, ...chunk)) stats.set(r.video_id, r);
    for (const r of q.all(`SELECT video_id, COUNT(*) AS n FROM impressions WHERE user_id = ? AND video_id IN (${marks}) GROUP BY video_id`, userId, ...chunk)) seen.set(r.video_id, r.n);
  }
  return { affinity, events, stats, seen };
}

/**
 * Rank `candidates` for a viewer and return `size` picks, each { video, total, why, explanation,
 * parts }. Drop-in for ranker.rankBatch in the main feed.
 */
export function rankForUser(userId, candidates, size, { rand = Math.random, now: at = Date.now(), cfg = RANKING } = {}) {
  const model = loadUserModel(userId);
  const sig = loadSignals(userId, candidates, at, cfg);
  const user = {
    affinity: sig.affinity,
    events: sig.events,
    // The existing interest model (onboarding answers, searches, More/Less, learned tags) is one
    // term of the score, and its truthful explanation is reused. Its noise is turned off here.
    interest: (v) => {
      const s = scoreVideo(v, model, { rand: () => 0.5 });
      return s ? { match: s.match, why: s.why } : null;
    },
  };
  const ctx = { now: at, rand, stats: sig.stats, seen: sig.seen };
  const scored = [];
  for (const v of candidates) {
    const s = scoreCandidate(v, user, ctx, cfg);
    if (s) scored.push(s);
  }
  const cold = sig.events < cfg.coldStart.events;
  const rules = { ...cfg.diversity, maxSameTopicInRow: cold ? cfg.diversity.coldStartMaxSameTopicInRow : cfg.diversity.maxSameTopicInRow };
  return assembleBatch(scored, size, { rng: rand, rules, cfg }).map((c) => {
    const why = explainPick(c);
    return { ...c, why, explanation: why.label, explore: c.explored ? 1 : 0, match: c.parts.interest };
  });
}
