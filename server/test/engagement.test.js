// Engagement logging, the migration, the personalized feed end to end, and the API routes.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.AXOL_DB_PATH = ":memory:";
process.env.AXOL_DISABLE_AI = "1";
process.env.YOUTUBE_API_KEY = "test-key-not-real";
process.env.YOUTUBE_DAILY_UNITS = "0";
delete process.env.APIFY_TOKEN;

const { CATALOG } = await import("./fixtures/catalog.js");
const { loadCatalog, makeViewer, serveQueue } = await import("./helpers.js");
const { db, q } = await import("../src/db.js");
const { runMigrations, MIGRATIONS } = await import("../src/migrations.js");
const { recordEngagement, normalizeEvent } = await import("../src/engagement.js");
const { rankForUser, seededRng, clipKeys } = await import("../src/reelsRanker.js");
const { createSession } = await import("../src/auth.js");

loadCatalog();
const vid = (id) => CATALOG.find((c) => c.id === id);
const full = (impressionId, extra = {}) => ({ impressionId, type: "view", watchedMs: 20000, durationMs: 20000, completion: 1, rewatches: 0, ...extra });
const affinity = (userId, kind, key) => q.get("SELECT * FROM user_affinity WHERE user_id = ? AND kind = ? AND key = ?", userId, kind, key);
const stats = (videoId) => q.get("SELECT * FROM clip_stats WHERE video_id = ?", videoId);

test("migration: creates the ranking tables once and records its version", () => {
  const tables = new Set(q.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name));
  for (const t of ["engagement_events", "clip_stats", "user_affinity", "schema_migrations"]) assert.ok(tables.has(t), t);
  assert.deepEqual(q.all("SELECT version FROM schema_migrations").map((r) => r.version), MIGRATIONS.map((m) => m.version));
  assert.deepEqual(runMigrations(db), [], "running again does nothing");
});

test("normalize: unknown types and missing impressions are refused; values are clamped", () => {
  assert.equal(normalizeEvent({ type: "explode", impressionId: "x" }), null);
  assert.equal(normalizeEvent({ type: "like" }), null);
  const e = normalizeEvent({ type: "view", impressionId: "x", watchedMs: 1e12, durationMs: 20000 });
  assert.equal(e.watchedMs, 600000);
  assert.ok(e.completion <= 5);
  assert.equal(normalizeEvent({ type: "view", impressionId: "x", watchedMs: 800, durationMs: 20000 }).quickSkip, true);
});

test("logging: a full watch, a like and a share train creator, topic and tag affinity and the clip's stats", () => {
  const viewer = makeViewer();
  const [imp] = serveQueue(viewer, ["bmx-1"]);
  const r = recordEngagement(viewer, [full(imp, { rewatches: 1 }), { impressionId: imp, type: "like" }, { impressionId: imp, type: "share" }]);
  assert.deepEqual(r, { accepted: 3, applied: 3, rejected: 0 });
  const keys = clipKeys(vid("bmx-1"));
  assert.ok(affinity(viewer, "creator", keys.creator).score > 2);
  assert.ok(affinity(viewer, "topic", keys.topic).score > 2);
  assert.ok(affinity(viewer, "tag", "bmx"));
  const s = stats("bmx-1");
  assert.equal(s.views, 1); assert.equal(s.likes, 1); assert.equal(s.shares, 1); assert.equal(s.rewatches, 1);
  assert.equal(s.completion_sum, 1);
});

test("logging: repeats count once, like/unlike toggles cleanly, other people's impressions are refused", () => {
  const viewer = makeViewer();
  const other = makeViewer();
  const [imp] = serveQueue(viewer, ["coffee-tutorial"]);
  const [theirs] = serveQueue(other, ["coffee-pov"]);
  recordEngagement(viewer, [full(imp), full(imp)]);
  assert.equal(stats("coffee-tutorial").views, 1, "a retried view is not counted twice");
  recordEngagement(viewer, [{ impressionId: imp, type: "like" }, { impressionId: imp, type: "like" }]);
  assert.equal(stats("coffee-tutorial").likes, 1);
  recordEngagement(viewer, [{ impressionId: imp, type: "unlike" }, { impressionId: imp, type: "unlike" }]);
  assert.equal(stats("coffee-tutorial").likes, 0);
  recordEngagement(viewer, [{ impressionId: imp, type: "like" }]);
  assert.equal(stats("coffee-tutorial").likes, 1, "liking again after an unlike counts");
  const r = recordEngagement(viewer, [full(theirs)]);
  assert.deepEqual(r, { accepted: 0, applied: 0, rejected: 1 });
  assert.equal(q.get("SELECT COUNT(*) AS n FROM engagement_events WHERE user_id = ?", viewer).n, 7, "duplicates are logged but not applied");
});

test("logging: quick skips and hides push a creator and topic down", () => {
  const viewer = makeViewer();
  const [a, b] = serveQueue(viewer, ["ai-1", "ai-2"]);
  recordEngagement(viewer, [{ impressionId: a, type: "view", watchedMs: 700, durationMs: 20000 }, { impressionId: b, type: "hide" }]);
  assert.ok(affinity(viewer, "topic", clipKeys(vid("ai-1")).topic).score < 0);
  assert.equal(stats("ai-1").quick_skips, 1);
  assert.equal(stats("ai-2").hides, 1);
});

test("personalized feed: after watching and sharing BMX, the next batch leads with BMX and still mixes topics", () => {
  const viewer = makeViewer();
  const imps = serveQueue(viewer, ["bmx-1", "bmx-2"]);
  recordEngagement(viewer, imps.flatMap((i) => [full(i, { rewatches: 1 }), { impressionId: i, type: "like" }, { impressionId: i, type: "share" }]));
  const candidates = CATALOG.filter((c) => !["bmx-1", "bmx-2"].includes(c.id));
  const batch = rankForUser(viewer, candidates, 8, { rand: seededRng(5) });
  assert.equal(batch[0].video.id, "bmx-3");
  assert.ok(new Set(batch.map((b) => b.keys.topic)).size >= 5, "the rest of the batch is not all one topic");
  for (let i = 1; i < batch.length; i++) assert.notEqual(batch[i].keys.creator, batch[i - 1].keys.creator);
  const again = rankForUser(viewer, candidates, 8, { rand: seededRng(5) });
  assert.deepEqual(again.map((b) => b.video.id), batch.map((b) => b.video.id), "same seed, same feed");
});

test("cold start: a brand-new viewer gets popular clips first, one topic at a time", () => {
  const fans = makeViewer();
  const imps = serveQueue(fans, ["hoops-1", "hoops-1", "hoops-1", "hoops-1"]);
  recordEngagement(fans, imps.flatMap((i) => [full(i), { impressionId: i, type: "like" }, { impressionId: i, type: "share" }]));
  const newbie = makeViewer();
  const batch = rankForUser(newbie, CATALOG, 8, { rand: seededRng(9) });
  assert.equal(batch[0].video.id, "hoops-1");
  for (let i = 1; i < batch.length; i++) {
    if (batch[i].explored) continue;
    assert.notEqual(batch[i].keys.topic, batch[i - 1].keys.topic, `topic repeats at ${i}`);
  }
});

test("muted topics never come back through the new ranking", () => {
  const viewer = makeViewer([], { avoid: ["bmx"] });
  const batch = rankForUser(viewer, CATALOG, 12, { rand: seededRng(1) });
  assert.ok(batch.every((b) => !b.video.id.startsWith("bmx")));
});

test("API: POST /api/engagement records a batch; GET /api/feed serves a ranked batch", async () => {
  const express = (await import("express")).default;
  const { apiRouter } = await import("../src/routes/api.js");
  const app = express();
  app.use(express.json());
  app.use("/api", apiRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  try {
    const viewer = makeViewer([{ tag: "coffee", weight: 2, origin: "onboarding" }]);
    const token = createSession(viewer);
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    assert.equal((await fetch(`${base}/engagement`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
    assert.equal((await fetch(`${base}/engagement`, { method: "POST", headers: auth, body: JSON.stringify({ events: "nope" }) })).status, 400);
    const tooMany = Array.from({ length: 51 }, () => ({ impressionId: "x", type: "like" }));
    assert.equal((await fetch(`${base}/engagement`, { method: "POST", headers: auth, body: JSON.stringify({ events: tooMany }) })).status, 413);

    const feed = await (await fetch(`${base}/feed?n=6`, { headers: auth })).json();
    assert.equal(feed.items.length, 6);
    assert.ok(feed.items.every((i) => i.impressionId && i.reason && i.why));
    assert.equal(new Set(feed.items.map((i) => i.id)).size, 6);

    const [first, second] = feed.items;
    const before = (id) => stats(id) || { shares: 0, quick_skips: 0 };
    const s1 = before(first.id).shares, s2 = before(second.id).quick_skips;
    const res = await fetch(`${base}/engagement`, { method: "POST", headers: auth, body: JSON.stringify({ events: [
      { impressionId: first.impressionId, type: "view", watchedMs: 18000, durationMs: 20000, rewatches: 1 },
      { impressionId: first.impressionId, type: "copy_link" },
      { impressionId: second.impressionId, type: "view", watchedMs: 600, durationMs: 20000 },
      { impressionId: "not-mine", type: "like" },
    ] }) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, accepted: 3, applied: 3, rejected: 1 });
    assert.equal(stats(first.id).shares, s1 + 1);
    assert.equal(stats(second.id).quick_skips, s2 + 1);
  } finally {
    server.close();
  }
});
