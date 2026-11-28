// Clips that made the viewer laugh. The laugh itself is detected on the device; this module
// only stores which clip it was, never any face or camera data.
import { q, now } from "./db.js";
import { publicVideo } from "./videoView.js";

const DAY = 86400e3;

export function recordLaugh(impression) {
  const already = !!impression.laughed;
  if (!already) {
    const t = now();
    q.run("UPDATE impressions SET laughed = 1, laughed_at = ?, updated_at = ? WHERE id = ?", t, t, impression.id);
    impression.laughed = 1;
    impression.laughed_at = t;
  }
  return { ok: true, already };
}

export function laughStats(userId, { tzMinutes = 0 } = {}) {
  const tz = Math.max(-840, Math.min(840, Number(tzMinutes) || 0)) * 60e3;
  const dayOf = (ts) => Math.floor((ts + tz) / DAY);
  const today = dayOf(now());
  const rows = q.all(
    `SELECT i.laughed_at, v.*
     FROM impressions i JOIN videos v ON v.id = i.video_id
     WHERE i.user_id = ? AND i.laughed = 1
     ORDER BY i.laughed_at DESC`,
    userId,
  );
  const total = rows.length;
  const todayCount = rows.filter((r) => r.laughed_at && dayOf(r.laughed_at) === today).length;
  const days = new Set(rows.filter((r) => r.laughed_at).map((r) => dayOf(r.laughed_at)));
  let streak = 0;
  for (let d = today; days.has(d); d--) streak += 1;
  if (!streak) for (let d = today - 1; days.has(d); d--) streak += 1;
  return {
    today: todayCount,
    total,
    streak,
    clips: rows.slice(0, 12).map(publicVideo),
  };
}
