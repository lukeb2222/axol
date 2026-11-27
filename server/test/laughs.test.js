import { test } from "node:test";
import assert from "node:assert/strict";

process.env.AXOL_DB_PATH = ":memory:";
process.env.AXOL_DISABLE_AI = "1";

const { loadCatalog, makeViewer, serveQueue } = await import("./helpers.js");
const { q } = await import("../src/db.js");
const { recordLaugh, laughStats } = await import("../src/laughs.js");
const { engagementScore } = await import("../src/learner.js");

loadCatalog();
const videoA = q.get("SELECT id FROM videos LIMIT 1").id;
const videoB = q.get("SELECT id FROM videos WHERE id != ? LIMIT 1", videoA).id;

test("recording a laugh is idempotent and shows up in today's recap", () => {
  const user = makeViewer();
  const [imp] = serveQueue(user, [videoA]);
  const row = q.get("SELECT * FROM impressions WHERE id = ?", imp);
  const first = recordLaugh(row);
  assert.equal(first.already, false);
  const again = recordLaugh({ ...row, laughed: 1 });
  assert.equal(again.already, true);
  const stats = laughStats(user, { tzMinutes: 0 });
  assert.equal(stats.today, 1);
  assert.equal(stats.total, 1);
  assert.equal(stats.streak, 1);
  assert.equal(stats.clips.length, 1);
  assert.equal(stats.clips[0].id, videoA);
  const stored = q.get("SELECT laughed, laughed_at FROM impressions WHERE id = ?", imp);
  assert.equal(stored.laughed, 1);
  assert.ok(stored.laughed_at > 0);
});

test("laughs on earlier days count in the total and build a streak, not today's number", () => {
  const user = makeViewer();
  const [a, b] = serveQueue(user, [videoA, videoB]);
  recordLaugh(q.get("SELECT * FROM impressions WHERE id = ?", a));
  recordLaugh(q.get("SELECT * FROM impressions WHERE id = ?", b));
  const day = 86400e3;
  q.run("UPDATE impressions SET laughed_at = ? WHERE id = ?", Date.now() - day, b);
  const stats = laughStats(user, { tzMinutes: 0 });
  assert.equal(stats.today, 1);
  assert.equal(stats.total, 2);
  assert.equal(stats.streak, 2);
});

test("a laugh lifts engagement a little, but less than a like", () => {
  const base = engagementScore({ watched_ms: 13500, duration_ms: 30000 });
  const laughed = engagementScore({ watched_ms: 13500, duration_ms: 30000, laughed: 1 });
  const liked = engagementScore({ watched_ms: 13500, duration_ms: 30000, liked: 1 });
  assert.ok(laughed > base);
  assert.ok(laughed < liked);
});
