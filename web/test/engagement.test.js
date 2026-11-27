// The player's batched engagement log: what a view event says, and how the queue batches,
// flushes and retries. No browser needed: the sender is injected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { viewEvent, createEngagementQueue, engagementFromBeacon, shareKind, QUICK_SKIP_MS } from "../src/lib/engagement.js";

test("view event: completion, rewatches and the two-second quick skip", () => {
  const e = viewEvent("imp1", { watchedMs: 15000.4, durationMs: 20000, replays: 2 });
  assert.deepEqual(e, { impressionId: "imp1", type: "view", watchedMs: 15000, durationMs: 20000, completion: 0.75, rewatches: 2, quickSkip: false });
  assert.equal(viewEvent("imp2", { watchedMs: QUICK_SKIP_MS - 1, durationMs: 20000 }).quickSkip, true);
  assert.equal(viewEvent("imp3", { watchedMs: 5000, durationMs: 0 }).completion, 0, "unknown length never divides by zero");
});

test("queue: events are held until flushed, then sent together with a timestamp", async () => {
  const sent = [];
  const q = createEngagementQueue({ send: (b) => { sent.push(b); return Promise.resolve({ ok: true }); }, now: () => 123 });
  q.log({ impressionId: "a", type: "like" });
  q.log({ impressionId: "a", type: "share" });
  q.log({ type: "like" }); // no impression: dropped
  assert.equal(sent.length, 0);
  assert.equal(q.size, 2);
  await q.flush();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].map((e) => [e.type, e.ts]), [["like", 123], ["share", 123]]);
  assert.equal(q.size, 0);
  assert.equal(await q.flush(), null, "nothing to send, nothing sent");
});

test("queue: a full batch sends on its own", () => {
  const sent = [];
  const q = createEngagementQueue({ send: (b) => { sent.push(b); return Promise.resolve(); }, maxBatch: 3 });
  for (let i = 0; i < 7; i++) q.log({ impressionId: `i${i}`, type: "view" });
  assert.deepEqual(sent.map((b) => b.length), [3, 3]);
  assert.equal(q.size, 1);
});

test("queue: a failed send is retried once on the next flush, then dropped", async () => {
  let fail = 2;
  const sent = [];
  const q = createEngagementQueue({ send: (b) => { sent.push(b.map((e) => e.impressionId)); return fail-- > 0 ? Promise.reject(new Error("offline")) : Promise.resolve(); } });
  q.log({ impressionId: "a", type: "like" });
  await q.flush();
  assert.equal(q.size, 1, "kept for a retry");
  await q.flush();
  assert.equal(q.size, 0, "dropped after the retry fails too");
  assert.deepEqual(sent, [["a"], ["a"]]);
});

test("beacons: the player's existing per-clip events become engagement events", () => {
  assert.deepEqual(engagementFromBeacon({ impressionId: "a", type: "finish", watchedMs: 20000, durationMs: 20000, replays: 1 }),
    { impressionId: "a", type: "view", watchedMs: 20000, durationMs: 20000, completion: 1, rewatches: 1, quickSkip: false });
  assert.equal(engagementFromBeacon({ impressionId: "a", type: "skip", watchedMs: 500, durationMs: 20000 }).quickSkip, true);
  assert.deepEqual(engagementFromBeacon({ impressionId: "a", type: "like" }), { impressionId: "a", type: "like" });
  assert.deepEqual(engagementFromBeacon({ impressionId: "a", type: "hide" }), { impressionId: "a", type: "hide" });
  assert.deepEqual(engagementFromBeacon({ impressionId: "a", type: "share" }, () => "copy_link"), { impressionId: "a", type: "copy_link" });
  for (const type of ["progress", "broken", "cta"]) assert.equal(engagementFromBeacon({ impressionId: "a", type }), null);
  assert.equal(engagementFromBeacon({ type: "like" }), null);
});

test("share kind: share sheet on touch screens, copied link on computers", () => {
  const touch = () => ({ matches: true }), mouse = () => ({ matches: false });
  assert.equal(shareKind({ share() {} }, touch), "share");
  assert.equal(shareKind({ share() {} }, mouse), "copy_link");
  assert.equal(shareKind({}, touch), "copy_link");
});

test("queue: after the page starts unloading, the last clip's view is sent at once", () => {
  const sent = [];
  const q = createEngagementQueue({ send: (b, o) => { sent.push([b.map((e) => e.type), o.unload]); return Promise.resolve(); } });
  q.log({ impressionId: "a", type: "like" });
  q.unload();
  q.log({ impressionId: "a", type: "view" });
  assert.deepEqual(sent, [[["like"], true], [["view"], true]]);
  q.resume();
  q.log({ impressionId: "b", type: "like" });
  assert.equal(sent.length, 2, "back to batching once the page is visible again");
});
