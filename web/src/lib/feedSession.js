// Remember the feed you were watching so a refresh or a closed tab does not send you back to the start.

const PREFIX = "axol_feed_";
export const FEED_SESSION_MAX_AGE_MS = 12 * 3600e3;
const MAX_ITEMS = 60;

const keyOf = (userId) => `${PREFIX}${userId || "anon"}`;

export function saveFeedSession(userId, { items, index }, now = Date.now(), store = globalThis.localStorage) {
  if (!store || !userId || !Array.isArray(items) || !items.length) return false;
  const i = Math.max(0, Math.min(items.length - 1, Number(index) || 0));
  // Keep a window around the current clip so the payload stays small.
  const start = Math.max(0, i - 10);
  const slice = items.slice(start, start + MAX_ITEMS).filter((it) => it && it.impressionId && it.id);
  if (!slice.length) return false;
  const payload = { index: Math.min(i - start, slice.length - 1), savedAt: now, items: slice };
  try { store.setItem(keyOf(userId), JSON.stringify(payload)); return true; } catch { return false; }
}

export function loadFeedSession(userId, now = Date.now(), store = globalThis.localStorage) {
  if (!store || !userId) return null;
  try {
    const raw = JSON.parse(store.getItem(keyOf(userId)) || "null");
    if (!raw || !Array.isArray(raw.items) || !raw.items.length) return null;
    if (!Number.isFinite(raw.savedAt) || now - raw.savedAt > FEED_SESSION_MAX_AGE_MS) return null;
    const items = raw.items.filter((it) => it && typeof it.impressionId === "string" && it.id);
    if (!items.length) return null;
    const index = Math.max(0, Math.min(items.length - 1, Number(raw.index) || 0));
    return { items, index, savedAt: raw.savedAt };
  } catch { return null; }
}

export function clearFeedSession(userId, store = globalThis.localStorage) {
  if (!store) return;
  try { store.removeItem(keyOf(userId)); } catch {}
}
