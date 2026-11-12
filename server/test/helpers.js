// Test-only helpers: load the fixture catalog into the in-memory database and make a viewer.
import { db, q } from "../src/db.js";
import { CATALOG } from "./fixtures/catalog.js";

const cols = ["id", "source", "external_id", "embed_kind", "url", "title", "creator", "description", "thumbnail", "duration_ms", "tags_json", "query", "tagged", "created_at", "media_file"];

export function loadCatalog() {
  const ins = db.prepare(`INSERT OR REPLACE INTO videos (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
  for (const c of CATALOG) ins.run(...cols.map((k) => c[k]));
}

let n = 0;
/** A viewer with the given interests: [{ tag, weight, positive?, impressions?, origin? }]. */
export function makeViewer(interests = [], { avoid = [] } = {}) {
  const id = `viewer-${++n}`;
  q.run("INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, 'x', 'Test', 0)", id, `${id}@axol.test`);
  q.run("INSERT INTO profiles (user_id, avoid_json, onboarded, updated_at) VALUES (?, ?, 1, 0)", id, JSON.stringify(avoid));
  for (const i of interests) {
    q.run("INSERT INTO interests (user_id, tag, weight, impressions, positive, origin, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0)",
      id, i.tag, i.weight, i.impressions ?? i.positive ?? 0, i.positive ?? 0, i.origin || "learned");
  }
  return id;
}

/** Put clips in front of a viewer as served-but-unplayed impressions, in order. Returns impression ids. */
export function serveQueue(userId, videoIds) {
  return videoIds.map((vid, k) => {
    const id = `${userId}-imp-${vid}-${k}`;
    q.run("INSERT INTO impressions (id, user_id, video_id, served_at, duration_ms, reason, updated_at) VALUES (?, ?, ?, ?, 20000, 'seed', ?)", id, userId, vid, Date.now(), Date.now());
    return id;
  });
}

export const interestsOf = (userId) => q.all("SELECT tag, weight, impressions, positive, origin FROM interests WHERE user_id = ? ORDER BY tag", userId);
