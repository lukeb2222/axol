// Dashboard analytics and topic search.
import { Router } from "express";
import { db, q, uid, now, transaction } from "../db.js";
import { config } from "../config.js";
import { safeTags, completionOf } from "../learner.js";
import { publicVideo } from "../videoView.js";
import { searchCatalog, hydrate, broaden, discoveryOptions } from "../search.js";

export const insightsRouter = Router();

const DAY = 86400e3;

/* ---------------------------------- dashboard ---------------------------------- */

insightsRouter.get("/dashboard", (req, res) => {
  const userId = req.user.id;
  // Client's UTC offset in minutes (east positive) so "today" matches the viewer's clock.
  const tz = Math.max(-840, Math.min(840, Number(req.query.tz) || 0)) * 60e3;
  const dayOf = (ts) => Math.floor((ts + tz) / DAY);
  const today = dayOf(now());

  const rows = q.all(
    `SELECT i.served_at, i.watched_ms, i.duration_ms, i.score, i.finalized, i.liked, i.skipped, i.hidden, i.replays, v.source, v.tags_json
     FROM impressions i JOIN videos v ON v.id = i.video_id
     WHERE i.user_id = ? AND (i.finalized = 1 OR i.watched_ms > 0) ORDER BY i.served_at`, userId,
  );

  // Last 7 days, oldest first.
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const daily = [];
  for (let d = today - 6; d <= today; d++) {
    const date = new Date(d * DAY);
    daily.push({ day: d, date: date.toISOString().slice(0, 10), label: names[date.getUTCDay()], clips: 0, minutes: 0, completionSum: 0 });
  }
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const activeDays = new Set();
  const platforms = new Map();
  let watchedMs = 0, likes = 0, completionSum = 0, skips = 0, replays = 0;

  for (const r of rows) {
    const d = dayOf(r.served_at);
    activeDays.add(d);
    const c = Math.min(1, completionOf(r));
    watchedMs += r.watched_ms; likes += r.liked; completionSum += c; skips += r.skipped; replays += r.replays;
    const bucket = byDay.get(d);
    if (bucket) { bucket.clips += 1; bucket.minutes += r.watched_ms / 60e3; bucket.completionSum += c; }
    const p = platforms.get(r.source) || { source: r.source, clips: 0, watchedMs: 0, completionSum: 0 };
    p.clips += 1; p.watchedMs += r.watched_ms; p.completionSum += c;
    platforms.set(r.source, p);
  }
  for (const d of daily) {
    d.minutes = Math.round(d.minutes * 10) / 10;
    d.completion = d.clips ? Math.round((d.completionSum / d.clips) * 100) : null;
    delete d.completionSum; delete d.day;
  }

  let streak = 0;
  for (let d = today; activeDays.has(d); d--) streak++;
  if (!streak) for (let d = today - 1; activeDays.has(d); d--) streak++; // still alive until today ends

  // What is landing vs. being skipped: mean engagement per tag over the most recent clips.
  const recent = rows.filter((r) => r.finalized).slice(-80);
  const perTag = new Map();
  for (const r of recent) {
    // Credit each clip to its main topic only; secondary tags would repeat the same clips.
    for (const t of safeTags(r.tags_json).slice(0, 1)) {
      const e = perTag.get(t.tag) || { tag: t.tag, sum: 0, n: 0 };
      e.sum += r.score; e.n += 1;
      perTag.set(t.tag, e);
    }
  }
  const tagStats = [...perTag.values()].filter((e) => e.n >= 2).map((e) => ({ tag: e.tag, score: Math.round((e.sum / e.n) * 100) / 100, clips: e.n }));
  const landing = tagStats.filter((t) => t.score > 0.05).sort((a, b) => b.score - a.score).slice(0, 5);
  const skipping = tagStats.filter((t) => t.score < -0.05).sort((a, b) => a.score - b.score).slice(0, 5);

  const liked = q.all(
    `SELECT v.*, MAX(i.updated_at) AS at
     FROM impressions i JOIN videos v ON v.id = i.video_id WHERE i.user_id = ? AND i.liked = 1
     GROUP BY v.id ORDER BY at DESC LIMIT 12`, userId,
  ).map(publicVideo);

  const interests = q.all("SELECT tag, weight, origin FROM interests WHERE user_id = ? ORDER BY weight DESC", userId);
  const prof = q.get("SELECT synth_count, summary FROM profiles WHERE user_id = ?", userId);
  const insights = q.all("SELECT summary, mode, created_at FROM synth_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 4", userId);

  const todayRow = daily[6], yesterday = daily[5];
  res.json({
    today: { clips: todayRow.clips, minutes: todayRow.minutes, clipsDelta: todayRow.clips - yesterday.clips, minutesDelta: Math.round((todayRow.minutes - yesterday.minutes) * 10) / 10 },
    totals: {
      clips: rows.length, minutes: Math.round(watchedMs / 60e3), likes, replays,
      completion: rows.length ? Math.round((completionSum / rows.length) * 100) : null,
      skipRate: rows.length ? Math.round((skips / rows.length) * 100) : null,
    },
    streak,
    daily,
    platforms: [...platforms.values()].map((p) => ({
      source: p.source, clips: p.clips, minutes: Math.round(p.watchedMs / 6e3) / 10,
      share: watchedMs ? Math.round((p.watchedMs / watchedMs) * 100) : 0,
      completion: Math.round((p.completionSum / p.clips) * 100),
    })).sort((a, b) => b.minutes - a.minutes),
    landing, skipping, liked,
    taste: {
      summary: prof?.summary || "", tunes: prof?.synth_count || 0,
      interests: interests.length, learned: interests.filter((i) => i.origin === "learned").length,
      top: interests.slice(0, 5).map((i) => i.tag),
    },
    insights,
  });
});

/* ------------------------------------ search ------------------------------------ */

/**
 * GET /search?q=…&scope=strong|related&refresh=1
 * Catalog results only. `ids` is the full ordered result list, `total` its length, `items` its
 * first page. `refresh=1` re-reads a search already made without recording it as a new interest.
 */
insightsRouter.get("/search", (req, res) => {
  const raw = String(req.query.q || "").trim().slice(0, 80);
  if (raw.replace(/[^a-z0-9]/gi, "").length < 2) return res.status(400).json({ error: "type a topic to search" });
  const scope = req.query.scope === "related" ? "related" : "strong";
  res.json(searchCatalog(req.user.id, raw, { scope, n: Math.min(24, Number(req.query.n) || 18), remember: req.query.refresh !== "1" }));
});

/** POST /search/items { q, ids } — the next page of a result list, by id, so paging can never drift from it. */
insightsRouter.post("/search/items", (req, res) => {
  res.json({ items: hydrate(req.user.id, String(req.body?.q || "").slice(0, 80), Array.isArray(req.body?.ids) ? req.body.ids : []) });
});

const liveSearches = new Map(); // userId -> timestamps, to keep one person from draining shared quota
function allowLive(userId) {
  const t = now();
  const list = (liveSearches.get(userId) || []).filter((x) => t - x < 3600e3);
  if (list.length >= 12) { liveSearches.set(userId, list); return false; }
  list.push(t); liveSearches.set(userId, list);
  return true;
}

/** POST /search/discover { q } — the optional "look for fresh clips on the platforms" action. */
insightsRouter.post("/search/discover", async (req, res) => {
  const raw = String(req.body?.q || "").trim().slice(0, 80);
  if (raw.replace(/[^a-z0-9]/gi, "").length < 2) return res.status(400).json({ error: "type a topic to search" });
  if (!allowLive(req.user.id)) return res.json({ started: [], limited: true, ...discoveryOptions(raw) });
  res.json(await broaden(req.user.id, raw));
});

insightsRouter.get("/search/suggest", (req, res) => {
  // Topics with the most clips in the catalog right now, minus generic format tags.
  const counts = new Map();
  for (const r of q.all("SELECT tags_json FROM videos WHERE tagged = 1 ORDER BY created_at DESC LIMIT 1500")) {
    for (const t of safeTags(r.tags_json).slice(0, 2)) counts.set(t.tag, (counts.get(t.tag) || 0) + 1);
  }
  const generic = new Set(["shorts", "youtube", "tiktok", "instagram", "viral", "fyp", "trending", "comedy", "funny", "entertainment", "highlight", "tutorial", "pov", "music"]);
  const mine = q.all("SELECT tag FROM interests WHERE user_id = ? AND weight > 0 ORDER BY weight DESC LIMIT 6", req.user.id).map((r) => r.tag);
  const popular = [...counts.entries()].filter(([t, n]) => n >= 3 && !generic.has(t)).sort((a, b) => b[1] - a[1]).slice(0, 18).map(([t]) => t);
  res.json({ mine, popular: popular.filter((t) => !mine.includes(t)).slice(0, 14) });
});
