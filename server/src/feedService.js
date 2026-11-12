// Serving the feed, and re-planning the part of it the viewer has not reached yet.
import { db, q, uid, now, transaction } from "./db.js";
import { config } from "./config.js";
import { safeTags } from "./learner.js";
import { loadUserModel, rankBatch, scoreVideo, unseenCandidates } from "./ranker.js";
import { boostTopic, lessTopic } from "./preferences.js";
import { isAbout, topicKey, prettyTopic, steerableTopics } from "./topics.js";
import { publicVideo } from "./videoView.js";
import { saveQueries } from "./ingest.js";

const round = (x) => Math.round(x * 1000) / 1000;

/** One clip as the player receives it. `reason` is always `why.label`: one source for both. */
export function feedItem(impressionId, video, scored) {
  return { impressionId, reason: scored.why.label, why: scored.why, score: round(scored.total), ...publicVideo(video) };
}

/** Rank and record the next batch for this viewer. */
export function serveBatch(userId, candidates, size = config.ranking.batchSize, opts = {}) {
  const model = loadUserModel(userId);
  const picked = rankBatch(candidates, model, size, opts);
  const ins = db.prepare("INSERT INTO impressions (id, user_id, video_id, served_at, duration_ms, reason, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  return transaction(() => picked.map((p) => {
    const id = uid();
    ins.run(id, userId, p.video.id, now(), p.video.duration_ms, p.why.label, now());
    return feedItem(id, p.video, p);
  }));
}

/** Is this clip about the topic? Decided by its tags, the same way everywhere. */
export function clipIsAbout(video, topic) {
  return safeTags(video.tags_json).some((t) => (t.relevance ?? 1) >= 0.4 && isAbout(t.tag, topic));
}

export class SteerError extends Error {}

/**
 * "More ski tricks" / "Less BMX", tapped on the clip that is playing.
 *
 * 1. Records the preference (the same boost the profile screen uses; "less" is a down-weight).
 * 2. Re-plans the clips already loaded AFTER the current one. The current clip is never touched.
 *      less — every queued clip about the topic is swapped for the best clip that is not.
 *      more — up to two clips about the topic are placed within the next three, taken first from
 *             further down the queue and then from the catalog.
 * 3. Reports what actually happened, so the app only promises what it has: if nothing matching is
 *    in stock, it says so instead of implying an immediate change.
 *
 * `queue` is the list of impression ids the player has loaded after the current clip, in order.
 */
export function steerFeed(userId, { impressionId, tag, direction, queue = [], replan = true }, opts = {}) {
  if (direction !== "more" && direction !== "less") throw new SteerError("direction must be more or less");
  const current = q.get("SELECT i.id, i.video_id, v.tags_json FROM impressions i JOIN videos v ON v.id = i.video_id WHERE i.id = ? AND i.user_id = ?", String(impressionId || ""), userId);
  if (!current) throw new SteerError("unknown clip");
  // Only topics that actually describe the clip on screen can be steered from it.
  const offered = steerableTopics(safeTags(current.tags_json), { max: 6 });
  const topic = offered.find((t) => topicKey(t.tag) === topicKey(tag));
  if (!topic) throw new SteerError("that topic does not describe this clip");
  const label = prettyTopic(topic.tag);

  const pref = direction === "more" ? boostTopic(userId, topic.tag, { create: true }) : lessTopic(userId, topic.tag);
  if (direction === "more") {
    const text = topic.tag.replace(/-/g, " ");
    saveQueries(userId, { youtube: [`${text} shorts`], tiktok: [text], instagram: [text] });
  }
  const base = { direction, topic: topic.tag, label, weight: pref ? round(pref.weight) : null };
  if (!replan) {
    return { ...base, queue: null, removed: 0, added: 0, inNextThree: null,
      message: direction === "more" ? `More ${label}: added to your feed.` : `Less ${label}: your feed will show fewer.` };
  }

  // The loaded, unplayed clips after the current one, in the player's order.
  const ids = [...new Set((queue || []).map(String))].filter((id) => id !== current.id).slice(0, 40);
  const rows = ids.length
    ? q.all(`SELECT i.id AS impression_id, i.watched_ms, i.finalized, v.* FROM impressions i JOIN videos v ON v.id = i.video_id
             WHERE i.user_id = ? AND i.id IN (${ids.map(() => "?").join(",")})`, userId, ...ids)
    : [];
  const byImp = new Map(rows.map((r) => [r.impression_id, r]));
  const queued = ids.map((id) => byImp.get(id)).filter((r) => r && !r.finalized && r.watched_ms === 0);

  const model = loadUserModel(userId); // already reflects the new preference
  const taken = new Set([current.video_id, ...queued.map((r) => r.id)]);
  const pool = unseenCandidates(userId).filter((v) => !taken.has(v.id));
  const best = (list, n) => rankBatch(list, model, n, { ...opts, wild: false });

  let next = queued.map((r) => ({ kind: "kept", impressionId: r.impression_id, video: r }));
  let removed = 0, added = 0;
  const release = [];

  if (direction === "less") {
    const victims = queued.filter((r) => clipIsAbout(r, topic.tag));
    const replacements = best(pool.filter((v) => !clipIsAbout(v, topic.tag)), victims.length);
    let k = 0;
    next = [];
    for (const r of queued) {
      if (!clipIsAbout(r, topic.tag)) { next.push({ kind: "kept", impressionId: r.impression_id, video: r }); continue; }
      removed++;
      release.push(r.impression_id);
      const rep = replacements[k++];
      if (rep) { next.push({ kind: "new", video: rep.video, scored: rep }); added++; }
    }
  } else {
    const isOn = (e) => clipIsAbout(e.video, topic.tag);
    const want = Math.max(0, 2 - next.slice(0, 3).filter(isOn).length);
    const inserts = [];
    // Matching clips already loaded further down move up first; then the catalog supplies more.
    for (let i = next.length - 1; i >= 3 && inserts.length < want; i--) if (isOn(next[i])) inserts.unshift(next.splice(i, 1)[0]);
    const fromCatalog = best(pool.filter((v) => clipIsAbout(v, topic.tag)), want - inserts.length);
    for (const c of fromCatalog) { inserts.push({ kind: "new", video: c.video, scored: c }); added++; }
    inserts.forEach((entry, k) => {
      let pos = k === 0 ? 0 : 2;
      while (pos < 3 && next[pos] && isOn(next[pos])) pos++;
      next.splice(Math.min(pos, next.length), 0, entry);
    });
  }

  const ins = db.prepare("INSERT INTO impressions (id, user_id, video_id, served_at, duration_ms, reason, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const relabel = db.prepare("UPDATE impressions SET reason = ? WHERE id = ?");
  const drop = db.prepare("DELETE FROM impressions WHERE id = ? AND user_id = ? AND finalized = 0 AND watched_ms = 0");
  const items = transaction(() => {
    for (const id of release) drop.run(id, userId); // never shown, so they stay eligible later
    return next.map((e) => {
      // Explanations are recomputed against the updated profile so labels stay truthful.
      const scored = e.scored || scoreVideo(e.video, model, { rand: () => 0.5 }) || { total: 0, why: { kind: "discovery", label: "Something new, to see if it lands", topic: null, clipTopics: [], detail: "" } };
      let id = e.impressionId;
      if (id) relabel.run(scored.why.label, id);
      else { id = uid(); ins.run(id, userId, e.video.id, now(), e.video.duration_ms, scored.why.label, now()); }
      return feedItem(id, e.video, scored);
    });
  });

  const inNextThree = items.slice(0, 3).filter((it) => it.tags.some((t) => isAbout(t, topic.tag))).length;
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  let message;
  if (direction === "less") {
    if (removed && added >= removed) message = `Less ${label}: swapped ${plural(removed, "upcoming clip")} for something else.`;
    else if (removed) message = `Less ${label}: removed ${plural(removed, "upcoming clip")}.`;
    else message = `Less ${label}: none were lined up, and you'll see fewer from here on.`;
  } else if (inNextThree > 0) {
    message = `More ${label}: ${inNextThree === 1 ? "one is" : `${inNextThree} are`} in your next three clips.`;
  } else {
    // Thin inventory: record the wish, promise nothing about the next swipe.
    message = `More ${label}: noted. axol has no more ready right now, so it will look for some.`;
  }
  return { ...base, queue: items, removed, added, inNextThree, inventory: direction === "more" && inNextThree === 0 ? "thin" : "ok", message };
}
