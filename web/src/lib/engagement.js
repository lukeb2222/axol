// Batched engagement log for the feed ranking (server: POST /api/engagement).
// Events are queued in memory and sent together: every few seconds, as soon as a batch fills
// up, and when the page is hidden or closed (with keepalive so the request survives unload).
// The queue itself is plain logic so it can be tested without a browser.

export const FLUSH_EVERY_MS = 5000;
export const MAX_BATCH = 20;
export const QUICK_SKIP_MS = 2000;

/** A view summary for one clip, built when it leaves the screen. */
export function viewEvent(impressionId, { watchedMs = 0, durationMs = 0, replays = 0 } = {}) {
  const w = Math.max(0, Math.round(watchedMs));
  const d = Math.max(0, Math.round(durationMs));
  return {
    impressionId, type: "view", watchedMs: w, durationMs: d,
    completion: d > 0 ? Math.round((w / d) * 1000) / 1000 : 0,
    rewatches: Math.max(0, replays | 0),
    quickSkip: w < QUICK_SKIP_MS,
  };
}

/** How a share went out: the share sheet on touch devices, a copied link otherwise. */
export function shareKind(nav = typeof navigator !== "undefined" ? navigator : null, mm = typeof matchMedia !== "undefined" ? matchMedia : null) {
  try {
    return nav?.share && (!mm || mm("(pointer: coarse)").matches) ? "share" : "copy_link";
  } catch {
    return "copy_link";
  }
}

/**
 * The engagement event (if any) for one of the player's existing per-clip beacons, so every
 * place that likes, shares, hides or finishes a clip (buttons, double tap, keyboard, hands-free)
 * is logged without each needing its own call.
 */
export function engagementFromBeacon(body, share = shareKind) {
  const id = body?.impressionId;
  if (!id) return null;
  switch (body.type) {
    case "finish":
    case "skip": return viewEvent(id, body);
    case "like":
    case "unlike":
    case "hide": return { impressionId: id, type: body.type };
    case "share": return { impressionId: id, type: share() };
    default: return null; // progress, broken, cta
  }
}

export function createEngagementQueue({ send, now = () => Date.now(), maxBatch = MAX_BATCH } = {}) {
  let queue = [];
  let unloading = false;
  const api = {
    get size() { return queue.length; },
    log(evt) {
      if (!evt || !evt.impressionId || !evt.type) return;
      queue.push({ ...evt, ts: now() });
      // Once the page is going away, anything new (the last clip's view) is sent straight away.
      if (queue.length >= maxBatch || unloading) api.flush({ unload: unloading });
    },
    /** The page is being hidden or closed: send what's queued now and anything logged after. */
    unload() { unloading = true; return api.flush({ unload: true }); },
    /** The page is visible again. */
    resume() { unloading = false; },
    /** Send everything queued. Failed sends are put back (once) for the next flush. */
    flush({ unload = false } = {}) {
      if (!queue.length) return Promise.resolve(null);
      const batch = queue.splice(0, maxBatch);
      const rest = queue.length ? api.flush({ unload }) : null;
      // send() starts synchronously so a request made during page unload is actually issued.
      let sending;
      try { sending = Promise.resolve(send(batch, { unload })); } catch (e) { sending = Promise.reject(e); }
      return sending
        .catch(() => { if (!unload) queue = [...batch.filter((e) => !e.retried).map((e) => ({ ...e, retried: true })), ...queue]; return null; })
        .then((r) => rest || r);
    },
  };
  return api;
}

function postBatch(events, { unload } = {}) {
  const t = localStorage.getItem("axol_token");
  return fetch("/api/engagement", {
    method: "POST", keepalive: true,
    headers: { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) },
    body: JSON.stringify({ events: events.map(({ retried, ...e }) => e) }),
  }).then((r) => {
    if (!r.ok && r.status >= 500 && !unload) throw new Error(`engagement ${r.status}`);
    return r.json().catch(() => null);
  });
}

let shared = null;
/** The app-wide queue, created on first use with its timers and unload hooks. */
export function engagement() {
  if (shared) return shared;
  shared = createEngagementQueue({ send: postBatch });
  if (typeof window !== "undefined") {
    setInterval(() => shared.flush(), FLUSH_EVERY_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") shared.flush({ unload: true });
      else shared.resume();
    });
    window.addEventListener("pagehide", () => shared.unload());
    window.addEventListener("pageshow", () => shared.resume());
  }
  return shared;
}

/** Shorthand used by the player. */
export const logEngagement = (evt) => engagement().log(evt);

/** Mirror one of the player's beacons into the engagement log. Never throws. */
export function mirrorBeacon(body) {
  try {
    const evt = engagementFromBeacon(body);
    if (evt) logEngagement(evt);
  } catch {}
}
