import { test } from "node:test";
import assert from "node:assert/strict";
process.env.AXOL_DB_PATH = ":memory:";
process.env.AXOL_DISABLE_AI = "1";
const { engagementScore } = await import("../src/learner.js");
const { scoreVideo, rankBatch, buildModel } = await import("../src/ranker.js");
const { heuristicInitial } = await import("../src/ai/profile.js");

test("engagement: quick skip is strongly negative", () => {
  assert.ok(engagementScore({ watched_ms: 800, duration_ms: 30000 }) <= -0.9);
});
test("engagement: full watch is positive, loop + like is higher", () => {
  const full = engagementScore({ watched_ms: 30000, duration_ms: 30000 });
  const loop = engagementScore({ watched_ms: 42000, duration_ms: 30000, replays: 1, liked: 1 });
  assert.ok(full > 0.8);
  assert.ok(loop > full);
});
test("engagement: ~45% watch is neutral", () => {
  assert.ok(Math.abs(engagementScore({ watched_ms: 13500, duration_ms: 30000 })) < 0.05);
});
test("ranker: matching interests outrank non-matching, avoid list filters", () => {
  const model = buildModel({ interests: [{ tag: "skateboarding", weight: 3, impressions: 10, positive: 5 }], avoid: ["politics"], totalViews: 20 });
  const mk = (tags) => ({ id: tags.join(), tags_json: JSON.stringify(tags.map((t) => ({ tag: t, relevance: 1 }))), created_at: Date.now(), source: "youtube", embed_kind: "youtube", creator: "" });
  const rand = () => 0.5;
  const a = scoreVideo(mk(["skateboarding"]), model, { rand });
  const b = scoreVideo(mk(["knitting"]), model, { rand });
  assert.ok(a.total > b.total);
  assert.equal(scoreVideo(mk(["politics"]), model, { rand }), null);
  const batch = rankBatch([mk(["skateboarding"]), mk(["skateboarding", "tricks"]), mk(["knitting"]), mk(["jazz"])], model, 3, { rand });
  assert.equal(batch.length, 3);
  assert.equal(batch[0].video.id, "skateboarding");
});
test("heuristic profile extracts tags and dislikes", () => {
  const p = heuristicInitial("I love skateboarding and jazz. No politics.", []);
  const tags = p.interests.map((i) => i.tag);
  assert.ok(tags.includes("skateboarding") && tags.includes("jazz"));
  assert.ok(p.queries.youtube.length > 0);
});

test("ranker: related-word interests match and related avoids filter", () => {
  const model = buildModel({ interests: [{ tag: "specialty-coffee", weight: 3, impressions: 0, positive: 2 }], avoid: ["pranks"], totalViews: 5 });
  const mk = (tags) => ({ id: tags.join(), tags_json: JSON.stringify(tags.map((t) => ({ tag: t, relevance: 1 }))), created_at: Date.now(), source: "youtube", embed_kind: "youtube", creator: "" });
  const rand = () => 0.5;
  const coffee = scoreVideo(mk(["coffee"]), model, { rand });
  const other = scoreVideo(mk(["baseball"]), model, { rand });
  assert.ok(coffee.match > 1.5 && coffee.total > other.total);
  assert.equal(coffee.explanation, "Because you watch coffee");
  assert.equal(scoreVideo(mk(["prank-videos"]), model, { rand }), null);
});
