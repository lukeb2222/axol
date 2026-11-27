// A member's liked clips and recently watched clips, served as playable player items.
import { db, q, uid, now, transaction } from "./db.js";
import { publicVideo } from "./videoView.js";
import { PLAYABLE } from "./ranker.js";

const MIN_WATCH_MS = 1500;

function serve(userId, videos, reason, detail) {
  const ins = db.prepare("INSERT INTO impressions (id, user_id, video_id, served_at, duration_ms, reason, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  return transaction(() => videos.map((v) => {
    const id = uid();
    ins.run(id, userId, v.id, now(), v.duration_ms, reason, now());
    const item = publicVideo(v);
    return {
      impressionId: id, reason, liked: v._liked === 1, watchedAt: v._at, ...item,
      why: { kind: "library", label: reason, topic: null, clipTopics: item.topics.map((t) => t.label), detail },
    };
  }));
}

function rowsFor(userId, { likedOnly = false, limit = 40 } = {}) {
  const likeClause = likedOnly ? "AND i.liked = 1" : "AND i.hidden = 0 AND i.watched_ms >= ?";
  const params = likedOnly ? [userId, limit] : [userId, MIN_WATCH_MS, limit];
  return q.all(
    `SELECT v.*, MAX(i.updated_at) AS _at, MAX(i.liked) AS _liked
     FROM impressions i JOIN videos v ON v.id = i.video_id
     WHERE i.user_id = ? ${likeClause} AND v.tagged = 1 AND ${PLAYABLE}
     GROUP BY v.id ORDER BY _at DESC LIMIT ?`,
    ...params,
  );
}

/** Unique liked clips, most recently liked first. */
export function likedItems(userId, { limit = 40 } = {}) {
  return serve(userId, rowsFor(userId, { likedOnly: true, limit }), "You liked this", "You liked this clip earlier, so you can watch it again here.");
}

/** Unique clips this person actually watched, most recent first. Hidden clips are left out. */
export function historyItems(userId, { limit = 40 } = {}) {
  return serve(userId, rowsFor(userId, { likedOnly: false, limit }), "Watched earlier", "You watched this earlier. Open it again here, without leaving axol.");
}

export function getLibrary(userId) {
  return { liked: likedItems(userId), history: historyItems(userId) };
}

/** Like or unlike should apply to the clip, not one impression of it. */
export function setLiked(userId, videoId, liked) {
  q.run("UPDATE impressions SET liked = ?, updated_at = ? WHERE user_id = ? AND video_id = ?", liked ? 1 : 0, now(), userId, videoId);
}
