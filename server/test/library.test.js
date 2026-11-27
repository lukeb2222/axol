import { test } from "node:test";
import assert from "node:assert/strict";
process.env.AXOL_DB_PATH = ":memory:";
process.env.AXOL_DISABLE_AI = "1";
const { loadCatalog, makeViewer } = await import("./helpers.js");
const { q, now } = await import("../src/db.js");
const { likedItems, historyItems, setLiked, getLibrary } = await import("../src/library.js");

loadCatalog();
const clips = q.all("SELECT id FROM videos ORDER BY id LIMIT 5");
assert.ok(clips.length >= 5, "fixture catalog should have clips");

function serve(userId, videoId, { liked = 0, hidden = 0, watched = 0, at = now() } = {}) {
  const id = `${userId}-${videoId}-${at}-${Math.random().toString(16).slice(2)}`;
  q.run("INSERT INTO impressions (id, user_id, video_id, served_at, watched_ms, duration_ms, liked, hidden, reason, updated_at) VALUES (?, ?, ?, ?, ?, 20000, ?, ?, 'test', ?)",
    id, userId, videoId, at, watched, liked, hidden, at);
  return id;
}

test("liked clips are unique, newest first, and only this person's", () => {
  const user = makeViewer([{ tag: "skiing", weight: 0.9 }]);
  const other = makeViewer([{ tag: "skiing", weight: 0.9 }]);
  serve(user, clips[0].id, { liked: 1, watched: 8000, at: 100 });
  serve(user, clips[0].id, { liked: 1, watched: 3000, at: 300 });
  serve(user, clips[1].id, { liked: 1, watched: 5000, at: 200 });
  serve(other, clips[2].id, { liked: 1, watched: 9000, at: 400 });
  const items = likedItems(user);
  assert.deepEqual(items.map((i) => i.id), [clips[0].id, clips[1].id]);
  assert.ok(items.every((i) => i.impressionId && i.url && i.reason === "You liked this"));
  assert.ok(items[0].liked);
  assert.equal(likedItems(other).length, 1);
  assert.equal(likedItems(other)[0].id, clips[2].id);
});

test("unliking a clip removes it from the liked list even if an older impression was liked", () => {
  const user = makeViewer([{ tag: "skiing", weight: 0.9 }]);
  serve(user, clips[0].id, { liked: 1, watched: 4000, at: 10 });
  serve(user, clips[0].id, { liked: 1, watched: 4000, at: 20 });
  assert.equal(likedItems(user).some((i) => i.id === clips[0].id), true);
  setLiked(user, clips[0].id, false);
  assert.equal(likedItems(user).some((i) => i.id === clips[0].id), false);
  setLiked(user, clips[0].id, true);
  assert.equal(likedItems(user).some((i) => i.id === clips[0].id), true);
});

test("history lists clips actually watched, skips hidden and near-skips, and is unique", () => {
  const user = makeViewer([{ tag: "skiing", weight: 0.9 }]);
  serve(user, clips[3].id, { watched: 400, at: 1000 });
  serve(user, clips[4].id, { watched: 9000, hidden: 1, at: 1100 });
  serve(user, clips[2].id, { watched: 7000, at: 1200 });
  serve(user, clips[2].id, { watched: 2000, at: 1300 });
  const items = historyItems(user);
  const ids = items.map((i) => i.id);
  assert.ok(ids.includes(clips[2].id));
  assert.ok(!ids.includes(clips[3].id), "a 400ms glance is not history");
  assert.ok(!ids.includes(clips[4].id), "hidden clips stay out");
  assert.equal(ids.filter((id) => id === clips[2].id).length, 1);
  assert.ok(items[0].impressionId);
  assert.equal(items.find((i) => i.id === clips[2].id).reason, "Watched earlier");
});

test("the library payload has both shelves", () => {
  const user = makeViewer([{ tag: "skiing", weight: 0.9 }]);
  serve(user, clips[0].id, { liked: 1, watched: 6000, at: 50 });
  const lib = getLibrary(user);
  assert.ok(Array.isArray(lib.liked) && Array.isArray(lib.history));
  assert.ok(lib.liked.some((i) => i.id === clips[0].id));
  assert.ok(lib.history.some((i) => i.id === clips[0].id));
});
