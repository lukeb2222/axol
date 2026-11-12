// Dashboard analytics and topic search.
import { Router } from "express";
import { db, q, uid, now, transaction } from "../db.js";
import { config } from "../config.js";
import { safeTags, completionOf } from "../learner.js";
import { loadUserModel, scoreVideo, PLAYABLE } from "../ranker.js";
import { discoverTopic, topicStatus, saveQueries } from "../ingest.js";
import { normalizeTag } from "../ai/taxonomy.js";
import { publicVideo } from "../videoView.js";

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

const liveSearches = new Map(); // userId -> timestamps, to keep one person from draining shared quota
function allowLive(userId) {
  const t = now();
  const list = (liveSearches.get(userId) || []).filter((x) => t - x < 3600e3);
  if (list.length >= 12) { liveSearches.set(userId, list); return false; }
  list.push(t); liveSearches.set(userId, list);
  return true;
}
const stem = (w) => (w.length > 3 ? w.replace(/(ies)$/, "y").replace(/(ing|s)$/, "") : w);

insightsRouter.get("/search", async (req, res) => {
  const userId = req.user.id;
  const raw = String(req.query.q || "").trim().slice(0, 80);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const n = Math.min(24, Number(req.query.n) || 18);
  const words = raw.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w.length > 1).slice(0, 6);
  if (!words.length) return res.status(400).json({ error: "type a topic to search" });
  const phraseTag = normalizeTag(raw);
  const stems = words.map(stem);

  // A search is a statement of interest: remember it and keep discovering it.
  // `refresh` re-reads results for a search already made (more pages, late-arriving platforms)
  // without counting it as a new statement of interest or starting new discovery.
  const refresh = req.query.refresh === "1";
  let discovery = { started: 0, ...topicStatus(raw) };
  if (offset === 0 && !refresh) {
    const row = q.get("SELECT weight FROM interests WHERE user_id = ? AND tag = ?", userId, phraseTag);
    if (row) q.run("UPDATE interests SET weight = MIN(?, weight + 0.3), updated_at = ? WHERE user_id = ? AND tag = ?", config.learning.maxWeight, now(), userId, phraseTag);
    else q.run("INSERT INTO interests (user_id, tag, weight, impressions, positive, origin, updated_at) VALUES (?, ?, 0.8, 0, 0, 'search', ?)", userId, phraseTag, now());
    saveQueries(userId, { youtube: [`${raw.toLowerCase()} shorts`], tiktok: [raw.toLowerCase()], instagram: [raw.toLowerCase()] });
    if (allowLive(userId)) discovery = await discoverTopic(raw).catch(() => discovery);
  }

  // Match the catalog on tags, the query that found the clip, and the title.
  const like = stems.map(() => "(LOWER(v.title) LIKE ? OR v.tags_json LIKE ? OR LOWER(v.query) LIKE ?)").join(" OR ");
  const params = stems.flatMap((s) => [`%${s}%`, `%${s}%`, `%${s}%`]);
  const candidates = q.all(`SELECT v.* FROM videos v WHERE v.tagged = 1 AND ${PLAYABLE} AND (${like}) ORDER BY v.created_at DESC LIMIT 800`, ...params);
  const model = loadUserModel(userId);
  const scored = [];
  for (const v of candidates) {
    const tags = safeTags(v.tags_json);
    if (tags.some((t) => model.avoid.has(t.tag))) continue;
    const title = v.title.toLowerCase(), query = v.query.toLowerCase();
    let s = 0, hits = 0;
    for (const st of stems) {
      let hit = false;
      for (const t of tags) if (t.tag.split("-").some((part) => stem(part) === st)) { s += 2 * t.relevance; hit = true; }
      if (query.includes(st)) { s += 1.5; hit = true; }
      if (title.includes(st)) { s += 1; hit = true; }
      if (hit) hits++;
    }
    if (!hits) continue;
    if (tags.some((t) => t.tag === phraseTag)) s += 3;
    s *= hits / stems.length; // prefer clips matching every word
    const fit = scoreVideo(v, model, { rand: () => 0.5 });
    scored.push({ v, s: s + 0.15 * (fit?.match || 0) });
  }
  scored.sort((a, b) => b.s - a.s);

  // Light creator diversity so one account does not fill the grid.
  const seenCreators = new Map(), ordered = [];
  for (const c of scored) {
    const k = c.v.creator || c.v.id, count = seenCreators.get(k) || 0;
    seenCreators.set(k, count + 1);
    ordered.push({ ...c, s: c.s - count * 0.8 });
  }
  ordered.sort((a, b) => b.s - a.s);
  const page = ordered.slice(offset, offset + n);

  const ins = db.prepare("INSERT INTO impressions (id, user_id, video_id, served_at, duration_ms, reason, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const reason = `You searched ${raw}`;
  const items = transaction(() => page.map(({ v }) => {
    const id = uid();
    ins.run(id, userId, v.id, now(), v.duration_ms, reason, now());
    return { impressionId: id, reason, ...publicVideo(v) };
  }));
  res.json({ q: raw, items, total: ordered.length, hasMore: offset + n < ordered.length, pending: discovery.pending, paused: discovery.paused });
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
