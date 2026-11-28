import { test } from "node:test";
import assert from "node:assert/strict";
import { saveFeedSession, loadFeedSession, clearFeedSession, FEED_SESSION_MAX_AGE_MS } from "../src/lib/feedSession.js";
import { setPlayerCommands, playerCommands, SHORTCUTS } from "../src/lib/playerCommands.js";

function memoryStore(start = {}) {
  const data = { ...start };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
    data,
  };
}

const clip = (n) => ({ impressionId: `imp-${n}`, id: `vid-${n}`, title: `Clip ${n}` });

test("a saved feed session restores the clips and the place you were", () => {
  const store = memoryStore();
  const items = [clip(1), clip(2), clip(3)];
  assert.equal(saveFeedSession("u1", { items, index: 2 }, 1000, store), true);
  const loaded = loadFeedSession("u1", 1000, store);
  assert.deepEqual(loaded.items.map((i) => i.id), ["vid-1", "vid-2", "vid-3"]);
  assert.equal(loaded.index, 2);
});

test("an expired or empty session is ignored, and logout clears it", () => {
  const store = memoryStore();
  saveFeedSession("u1", { items: [clip(1)], index: 0 }, 1000, store);
  assert.equal(loadFeedSession("u1", 1000 + FEED_SESSION_MAX_AGE_MS + 1, store), null);
  saveFeedSession("u1", { items: [clip(1)], index: 0 }, 1000, store);
  clearFeedSession("u1", store);
  assert.equal(loadFeedSession("u1", 1000, store), null);
  assert.equal(saveFeedSession("u1", { items: [], index: 0 }, 1000, store), false);
  assert.equal(loadFeedSession("other", 1000, store), null);
});

test("player commands are the ones the active clip registered, and clear when it unregisters", () => {
  const first = { like() {} };
  const stop = setPlayerCommands(first);
  assert.equal(playerCommands(), first);
  stop();
  assert.equal(playerCommands(), null);
  const second = { pause() {} };
  const stop2 = setPlayerCommands(second);
  setPlayerCommands({ like() {} });
  stop2(); // should not clear the later registration
  assert.ok(playerCommands().like);
});

test("the shortcut list covers like, copy, pause and next", () => {
  const text = SHORTCUTS.map((s) => `${s.keys} ${s.action}`).join(" ").toLowerCase();
  assert.ok(text.includes("like"));
  assert.ok(text.includes("copy"));
  assert.ok(text.includes("pause"));
  assert.ok(text.includes("next"));
});
