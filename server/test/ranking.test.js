// Unit tests for the Reels-style ranking: event values, decay, scoring, diversity, exploration.
// Pure functions only; every random choice uses a seeded RNG so results are repeatable.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.AXOL_DB_PATH = ":memory:";
process.env.AXOL_DISABLE_AI = "1";

const {
  seededRng, decayed, eventValue, clipQuality, popularity, scoreCandidate, diversify, breaksRun,
  explorationSlots, assembleBatch, clipKeys, explainPick,
} = await import("../src/reelsRanker.js");
const { RANKING } = await import("../src/rankingConfig.js");

const DAY = 86400e3;
const NOW = Date.UTC(2026, 10, 27);
const T = (pairs) => JSON.stringify(pairs.map(([tag, relevance]) => ({ tag, relevance })));
const clip = (id, { creator = `@${id}`, tags = [["misc", 1]], ageDays = 1, media = true } = {}) =>
  ({ id, creator, tags_json: T(tags), created_at: NOW - ageDays * DAY, media_file: media ? `${id}.mp4` : "", source: "tiktok" });
const user = (aff = {}, events = 100) => ({ affinity: new Map(Object.entries(aff)), events, interest: () => ({ match: 0, why: null }) });
const ctx = (extra = {}) => ({ now: NOW, rand: () => 0.5, stats: new Map(), seen: new Map(), ...extra });

/* ------------------------------------------------------------------ helpers */

test("seeded RNG: same seed gives the same sequence, different seeds differ", () => {
  const a = seededRng(42), b = seededRng(42), c = seededRng(7);
  const sa = Array.from({ length: 5 }, a), sb = Array.from({ length: 5 }, b), sc = Array.from({ length: 5 }, c);
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa, sc);
  assert.ok(sa.every((x) => x >= 0 && x < 1));
});

test("decay: affinity halves every half-life and never grows", () => {
  const hl = RANKING.affinity.halfLifeDays;
  assert.equal(decayed(2, NOW, NOW), 2);
  assert.ok(Math.abs(decayed(2, NOW - hl * DAY, NOW) - 1) < 1e-9);
  assert.ok(Math.abs(decayed(2, NOW - 2 * hl * DAY, NOW) - 0.5) < 1e-9);
  assert.ok(Math.abs(decayed(-4, NOW - hl * DAY, NOW) + 2) < 1e-9, "negative affinity fades toward zero too");
  assert.equal(decayed(1, NOW + DAY, NOW), 1, "a timestamp in the future does not inflate");
});

/* ------------------------------------------------------------- event values */

test("event values: completion, rewatches and sends are positive; quick skips and hides negative", () => {
  const full = eventValue({ type: "view", watchedMs: 20000, completion: 1, rewatches: 0 });
  const half = eventValue({ type: "view", watchedMs: 10000, completion: 0.5 });
  const looped = eventValue({ type: "view", watchedMs: 40000, completion: 1, rewatches: 2 });
  const quick = eventValue({ type: "view", watchedMs: 900, completion: 0.05 });
  assert.ok(full > half && half > quick);
  assert.ok(looped > full, "a rewatch adds to a full watch");
  assert.ok(quick < 0, "leaving within two seconds is negative");
  assert.equal(eventValue({ type: "view", watchedMs: 900, quickSkip: true, completion: 1 }), RANKING.eventValue.quickSkip, "quick skip replaces the watch term");
  assert.ok(eventValue({ type: "share" }) > eventValue({ type: "like" }), "sends outrank likes (Mosseri, 2025)");
  assert.ok(eventValue({ type: "hide" }) < quick, "Not interested is the strongest negative");
  assert.equal(eventValue({ type: "like" }) + eventValue({ type: "unlike" }), 0);
  assert.equal(eventValue({ type: "save" }) + eventValue({ type: "unsave" }), 0);
  assert.equal(eventValue({ type: "view", watchedMs: 60000, completion: 1, rewatches: 99 }),
    eventValue({ type: "view", watchedMs: 60000, completion: 1, rewatches: RANKING.eventValue.maxRewatches }), "rewatches are capped");
});

/* ----------------------------------------------------------------- quality */

test("quality: an unseen clip is neutral; good rates lift it, skips sink it; few views are smoothed", () => {
  assert.ok(Math.abs(clipQuality(undefined).quality) < 1e-9);
  const great = (views) => ({ views, completion_sum: views * 0.95, likes: views * 0.2, shares: views * 0.1, saves: 0, quick_skips: 0, hides: 0 });
  const bad = { views: 50, completion_sum: 5, likes: 0, shares: 0, saves: 0, quick_skips: 40, hides: 5 };
  assert.ok(clipQuality(great(50)).quality > 0.5);
  assert.ok(clipQuality(bad).quality < -0.3);
  assert.ok(clipQuality(great(2)).quality < clipQuality(great(200)).quality, "two perfect views count for less than two hundred");
  assert.ok(popularity(great(200)) > popularity(great(5)));
  assert.ok(popularity(great(50)) > popularity(bad));
});

/* ----------------------------------------------------------------- scoring */

test("scoring: creator, topic and tag affinity each raise a clip; negative affinity lowers it", () => {
  const v = clip("a", { creator: "@Skater", tags: [["skateboarding", 1], ["tricks", 0.6]] });
  const keys = clipKeys(v);
  const base = scoreCandidate(v, user(), ctx()).total;
  const byCreator = scoreCandidate(v, user({ [`creator:${keys.creator}`]: { score: 3, positive: 3 } }), ctx()).total;
  const byTopic = scoreCandidate(v, user({ [`topic:${keys.topic}`]: { score: 3, positive: 3 } }), ctx()).total;
  const byTag = scoreCandidate(v, user({ [`tag:${keys.tags[1].key}`]: { score: 3, positive: 3 } }), ctx()).total;
  const disliked = scoreCandidate(v, user({ [`creator:${keys.creator}`]: { score: -3, positive: 0 } }), ctx()).total;
  assert.ok(byCreator > base && byTopic > base && byTag > base);
  assert.ok(disliked < base);
  assert.equal(keys.creator, "@skater", "creator keys are case-insensitive");
});

test("scoring: fresher clips score higher, already-seen clips lower, muted clips are dropped", () => {
  const fresh = scoreCandidate(clip("f", { ageDays: 0 }), user(), ctx()).total;
  const old = scoreCandidate(clip("o", { ageDays: 60 }), user(), ctx()).total;
  assert.ok(fresh > old);
  const v = clip("s");
  const unseen = scoreCandidate(v, user(), ctx()).total;
  const seenTwice = scoreCandidate(v, user(), ctx({ seen: new Map([["s", 2]]) })).total;
  assert.ok(Math.abs(unseen - seenTwice - 2 * RANKING.weights.seenPenalty) < 1e-9);
  assert.equal(scoreCandidate(v, { ...user(), interest: () => null }, ctx()), null);
});

test("cold start: with no history popularity decides; with history it fades out and affinity takes over", () => {
  const popular = clip("pop", { tags: [["cooking", 1]] });
  const niche = clip("niche", { tags: [["chess", 1]] });
  const stats = new Map([["pop", { views: 300, completion_sum: 260, likes: 60, shares: 30, saves: 10, quick_skips: 10, hides: 0 }]]);
  const chess = { "topic:chess": { score: 4, positive: 4 }, "tag:chess": { score: 4, positive: 4 } };
  const newbie = user({}, 0);
  assert.ok(scoreCandidate(popular, newbie, ctx({ stats })).parts.popularity > 0);
  assert.ok(scoreCandidate(popular, newbie, ctx({ stats })).total > scoreCandidate(niche, newbie, ctx({ stats })).total);
  // A new viewer's affinities barely count yet...
  assert.equal(scoreCandidate(niche, user(chess, 0), ctx({ stats })).parts.topic, 0);
  // ...and a regular's do, while popularity no longer applies.
  const regular = user(chess, RANKING.coldStart.events);
  assert.equal(scoreCandidate(popular, regular, ctx({ stats })).parts.popularity, 0);
  assert.ok(scoreCandidate(niche, regular, ctx({ stats })).total > scoreCandidate(popular, regular, ctx({ stats })).total);
});

/* --------------------------------------------------------------- diversity */

const scored = (id, creator, topic, total) => ({ video: { id }, keys: { creator, topic, tags: [] }, total, parts: {}, isNew: false, underExposed: false });

test("diversity: never more than N in a row from one creator or one topic", () => {
  const list = [
    scored("a1", "a", "skate", 10), scored("a2", "a", "skate", 9), scored("a3", "a", "skate", 8),
    scored("b1", "b", "skate", 7), scored("c1", "c", "skate", 6), scored("d1", "d", "cook", 5), scored("e1", "e", "chess", 4),
  ];
  const rules = { maxSameCreatorInRow: 1, maxSameTopicInRow: 2, window: 60 };
  const out = diversify(list, 7, rules);
  assert.equal(out.length, 7);
  for (let i = 1; i < out.length; i++) assert.notEqual(out[i].keys.creator, out[i - 1].keys.creator, `creator repeats at ${i}`);
  for (let i = 2; i < out.length - 2; i++) {
    const run = [out[i - 2], out[i - 1], out[i]].map((x) => x.keys.topic);
    assert.ok(!(run[0] === run[1] && run[1] === run[2]), `three ${run[0]} in a row at ${i}`);
  }
  assert.equal(out[0].video.id, "a1", "the best clip still leads");
  assert.ok(breaksRun([list[0]], list[1], rules));
  assert.ok(!breaksRun([list[0]], list[5], rules));
});

test("diversity: a catalog of one creator still fills the batch instead of coming back empty", () => {
  const list = [scored("a1", "a", "x", 3), scored("a2", "a", "x", 2), scored("a3", "a", "x", 1)];
  assert.deepEqual(diversify(list, 3).map((c) => c.video.id), ["a1", "a2", "a3"]);
});

/* ------------------------------------------------------------- exploration */

test("exploration: about 10-20% of slots, never the first two, never above the cap, repeatable per seed", () => {
  assert.deepEqual(explorationSlots(8, seededRng(3)), explorationSlots(8, seededRng(3)));
  const rng = seededRng(2026);
  let slots = 0, total = 0;
  for (let b = 0; b < 2000; b++) {
    const s = explorationSlots(8, rng);
    assert.ok(s.every((i) => i >= RANKING.exploration.firstSlot && i < 8));
    assert.ok(s.length <= Math.floor(8 * RANKING.exploration.maxShare));
    slots += s.length; total += 8;
  }
  const share = slots / total;
  assert.ok(share >= 0.08 && share <= 0.2, `exploration share ${share}`);
});

test("exploration: picks come from new or little-seen clips and the batch is deterministic per seed", () => {
  const list = [];
  for (let i = 0; i < 12; i++) list.push({ ...scored(`known${i}`, `k${i}`, `t${i % 4}`, 10 - i * 0.1) });
  for (let i = 0; i < 6; i++) list.push({ ...scored(`new${i}`, `n${i}`, `nt${i}`, 1 - i * 0.1), isNew: true });
  const run = (seed) => assembleBatch(list, 8, { rng: seededRng(seed) }).map((c) => `${c.video.id}${c.explored ? "*" : ""}`);
  assert.deepEqual(run(11), run(11));
  let explored = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const batch = assembleBatch(list, 8, { rng: seededRng(seed) });
    assert.equal(batch.length, 8);
    assert.equal(new Set(batch.map((c) => c.video.id)).size, 8, "no clip twice");
    for (const c of batch.filter((x) => x.explored)) { explored++; assert.ok(c.video.id.startsWith("new")); }
    assert.ok(!batch[0].explored && !batch[1].explored);
  }
  assert.ok(explored > 0, "exploration actually happens");
  const noExplore = assembleBatch(list, 8, { rng: () => 0.99 });
  assert.ok(noExplore.every((c) => !c.explored) && noExplore[0].video.id === "known0");
});

test("explanations: exploration picks say so; creator picks name the creator only with real history", () => {
  const base = { video: { creator: "@chef" }, parts: { creator: 0.6, topic: 0.1 }, why: { kind: "discovery", label: "x", clipTopics: [] } };
  assert.equal(explainPick({ ...base, explored: true }).kind, "discovery");
  assert.equal(explainPick({ ...base, creatorAffinity: { score: 2, positive: 3 } }).label, "Because you watch @chef");
  assert.equal(explainPick({ ...base, creatorAffinity: { score: 2, positive: 1 } }).kind, "discovery");
  const watch = { kind: "watch", label: "Because you watch cooking", clipTopics: [] };
  assert.equal(explainPick({ ...base, why: watch, creatorAffinity: { score: 2, positive: 5 } }).label, watch.label, "a topic reason is kept");
});
