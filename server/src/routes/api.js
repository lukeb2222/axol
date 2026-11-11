import { Router } from "express";
import { db, q, uid, now, transaction } from "../db.js";
import { config } from "../config.js";
import { requireAuth } from "../auth.js";
import { onboard, getProfile, maybeResynthesize } from "../profileService.js";
import { loadUserModel, rankBatch, unseenCandidates } from "../ranker.js";
import { runDiscovery, upsertVideos, tagPending, saveQueries } from "../ingest.js";
import { learnFromImpression, safeTags } from "../learner.js";
import { itemFromUrl, sourceStatus, SOURCES } from "../sources/index.js";
import { aiStatus } from "../ai/claude.js";
import { youtubeUnitsUsed } from "../sources/youtube.js";
import { discoveryState } from "../ingest.js";
import { insightsRouter } from "./insights.js";
import { apifyEnabled, apifyRunsToday } from "../sources/apify.js";

export const apiRouter = Router();

apiRouter.get("/health", (_req, res) => {
  res.json({
    ok: true,
    ai: aiStatus(),
    sources: sourceStatus(),
    catalog: q.get("SELECT COUNT(*) AS n FROM videos")?.n || 0,
    catalogBySource: Object.fromEntries(q.all("SELECT source, COUNT(*) AS n FROM videos GROUP BY source").map((r) => [r.source, r.n])),
    discoveryProvider: !!config.discoveryProviderUrl,
    // True when at least one automated discovery path exists; otherwise the feed is fed by pasted links.
    discoveryReady: !!config.youtubeApiKey || !!config.discoveryProviderUrl || apifyEnabled(),
    youtubeQuota: config.youtubeApiKey ? { used: youtubeUnitsUsed(), budget: config.youtubeDailyUnits } : null,
    apify: apifyEnabled() ? { runsToday: apifyRunsToday(), dailyBudget: config.apifyDailyRuns } : null,
    ...discoveryState(),
  });
});

apiRouter.use(requireAuth);

/* ---------------------------------- onboarding ---------------------------------- */

apiRouter.get("/onboarding/chips", (_req, res) => {
  res.json({ chips: CHIPS });
});

apiRouter.post("/onboarding", async (req, res) => {
  const text = String(req.body?.text || "").slice(0, 4000);
  const chips = Array.isArray(req.body?.chips) ? req.body.chips.map(String).slice(0, 30) : [];
  if (text.trim().length < 3 && chips.length === 0) return res.status(400).json({ error: "tell us at least one thing you love" });
  const profile = await onboard(req.user.id, { text, chips });
  res.json({ profile });
});

/* ------------------------------------- feed ------------------------------------- */

apiRouter.get("/feed", async (req, res) => {
  const userId = req.user.id;
  const size = Math.min(12, Number(req.query.n) || config.ranking.batchSize);
  let candidates = unseenCandidates(userId);
  if (candidates.length < config.ranking.minPool) {
    // Pool is thin: discover synchronously (bounded) so the feed never runs dry.
    await Promise.race([runDiscovery(userId, { limit: 3, staleMs: 0 }), sleep(12000)]);
    candidates = unseenCandidates(userId);
  }
  const model = loadUserModel(userId);
  const picked = rankBatch(candidates, model, size);

  const ins = db.prepare("INSERT INTO impressions (id, user_id, video_id, served_at, duration_ms, reason, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const items = transaction(() =>
    picked.map((p) => {
      const id = uid();
      ins.run(id, userId, p.video.id, now(), p.video.duration_ms, p.explanation, now());
      return { impressionId: id, reason: p.explanation, score: round(p.total), ...publicVideo(p.video) };
    }),
  );
  res.json({ items, poolSize: candidates.length, discovering: candidates.length < config.ranking.minPool, discoveryReady: !!config.youtubeApiKey || !!config.discoveryProviderUrl || apifyEnabled() });
});

/* ------------------------------------ events ------------------------------------ */

/**
 * Body: { impressionId, type, ... }
 *  progress  { watchedMs, durationMs, replays }       — sent every ~2s while the clip is on screen
 *  like / unlike / share / hide / skip
 *  finish    { watchedMs, durationMs, replays, skipped } — card left the screen; triggers learning
 */
apiRouter.post("/events", async (req, res) => {
  const userId = req.user.id;
  const { impressionId, type } = req.body || {};
  const imp = impressionId ? q.get("SELECT * FROM impressions WHERE id = ? AND user_id = ?", impressionId, userId) : null;
  if (!imp) return res.status(404).json({ error: "unknown impression" });
  q.run("INSERT INTO events (user_id, impression_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)", userId, impressionId, String(type), JSON.stringify(req.body), now());

  const b = req.body;
  const watched = Math.max(imp.watched_ms, Math.min(10 * 60e3, Number(b.watchedMs) || 0));
  const duration = Number(b.durationMs) > 0 ? Number(b.durationMs) : imp.duration_ms;
  const replays = Math.max(imp.replays, Number(b.replays) || 0);

  switch (type) {
    case "progress":
      q.run("UPDATE impressions SET watched_ms = ?, duration_ms = ?, replays = ?, updated_at = ? WHERE id = ?", watched, duration, replays, now(), imp.id);
      return res.json({ ok: true });
    case "like":
    case "unlike":
      q.run("UPDATE impressions SET liked = ?, updated_at = ? WHERE id = ?", type === "like" ? 1 : 0, now(), imp.id);
      return res.json({ ok: true });
    case "share":
      q.run("UPDATE impressions SET shared = 1, updated_at = ? WHERE id = ?", now(), imp.id);
      return res.json({ ok: true });
    case "broken":
      // The player could not play this clip. Close the impression at a neutral score: an
      // unplayable clip says nothing about the viewer's taste, and they will not be served it
      // again. Only a definitive platform verdict (removed, private, embedding disabled) retires
      // it for everyone (tagged = 2 keeps it out of every feed and search); a vague player error
      // can be one person's network or blocker.
      if (b.definitive === true) q.run("UPDATE videos SET tagged = 2 WHERE id = ?", imp.video_id);
      q.run("UPDATE impressions SET finalized = 1, score = 0, updated_at = ? WHERE id = ?", now(), imp.id);
      return res.json({ ok: true });
    case "hide":
      q.run("UPDATE impressions SET hidden = 1, updated_at = ? WHERE id = ?", now(), imp.id);
      break; // fall through to learning below
    case "skip":
    case "finish":
      q.run("UPDATE impressions SET watched_ms = ?, duration_ms = ?, replays = ?, skipped = ?, updated_at = ? WHERE id = ?",
        watched, duration, replays, b.skipped || type === "skip" ? 1 : 0, now(), imp.id);
      break;
    default:
      return res.status(400).json({ error: "unknown event type" });
  }

  // Learning step (hide / skip / finish). Idempotent per impression.
  const fresh = q.get("SELECT * FROM impressions WHERE id = ?", imp.id);
  if (fresh.finalized) return res.json({ ok: true, learned: null });
  const video = q.get("SELECT * FROM videos WHERE id = ?", fresh.video_id);
  const learned = learnFromImpression(userId, fresh, video);
  let synth = null;
  try {
    synth = await maybeResynthesize(userId);
  } catch (e) {
    console.warn("[resynth]", e.message);
  }
  res.json({ ok: true, learned: { score: round(learned.score), deltas: learned.deltas.slice(0, 4).map((d) => ({ ...d, delta: round(d.delta), weight: round(d.weight) })) }, synth });
});

apiRouter.use(insightsRouter);

/* ------------------------------------ profile ----------------------------------- */

apiRouter.get("/profile", (req, res) => res.json({ profile: getProfile(req.user.id) }));

apiRouter.post("/profile/refresh", async (req, res) => {
  const synth = await maybeResynthesize(req.user.id, { force: true });
  res.json({ synth, profile: getProfile(req.user.id) });
});

apiRouter.post("/profile/interest", (req, res) => {
  // Manual nudge from the profile screen: { tag, action: 'boost' | 'mute' | 'remove' }
  const tag = String(req.body?.tag || "");
  const action = String(req.body?.action || "");
  if (!tag) return res.status(400).json({ error: "tag required" });
  if (action === "remove") q.run("DELETE FROM interests WHERE user_id = ? AND tag = ?", req.user.id, tag);
  else if (action === "boost") q.run("UPDATE interests SET weight = MIN(?, weight + 1), updated_at = ? WHERE user_id = ? AND tag = ?", config.learning.maxWeight, now(), req.user.id, tag);
  else if (action === "mute") {
    const prof = q.get("SELECT avoid_json FROM profiles WHERE user_id = ?", req.user.id);
    const avoid = new Set(JSON.parse(prof?.avoid_json || "[]"));
    avoid.add(tag);
    q.run("UPDATE profiles SET avoid_json = ? WHERE user_id = ?", JSON.stringify([...avoid]), req.user.id);
    q.run("DELETE FROM interests WHERE user_id = ? AND tag = ?", req.user.id, tag);
  } else return res.status(400).json({ error: "unknown action" });
  res.json({ profile: getProfile(req.user.id) });
});

/* ------------------------------------- import ----------------------------------- */

/** Paste TikTok / Instagram / YouTube links to add them to the catalog (and your queries). */
apiRouter.post("/import", async (req, res) => {
  const urls = Array.isArray(req.body?.urls) ? req.body.urls : String(req.body?.text || "").split(/\s+/);
  const items = [];
  for (const u of urls) {
    const it = itemFromUrl(String(u));
    if (it) items.push(it);
  }
  if (!items.length) return res.status(400).json({ error: "no supported links found" });
  const enriched = await Promise.all(items.map((it) => (SOURCES[it.source].enrich ? SOURCES[it.source].enrich(it) : it)));
  const fresh = upsertVideos(enriched);
  await tagPending(fresh);
  res.json({ added: fresh.length, total: enriched.length });
});

apiRouter.post("/queries", (req, res) => {
  saveQueries(req.user.id, req.body?.queries || {});
  runDiscovery(req.user.id, { limit: 6, staleMs: 0 }).catch(() => {});
  res.json({ ok: true });
});

/* ----------------------------------- helpers ------------------------------------ */

function publicVideo(v) {
  return {
    id: v.id, source: v.source, externalId: v.external_id, embedKind: v.embed_kind, url: v.url,
    title: v.title, creator: v.creator, thumbnail: v.thumbnail, durationMs: v.duration_ms,
    tags: safeTags(v.tags_json).map((t) => t.tag), query: v.query,
  };
}
const round = (x) => Math.round(x * 1000) / 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const CHIPS = [
  "skateboarding", "basketball", "soccer", "fitness", "mma", "climbing", "surfing", "running",
  "cooking", "street-food", "coffee", "travel", "nature", "animals", "cars", "aviation",
  "science", "space", "engineering", "programming", "ai", "gadgets", "gaming", "anime",
  "music", "guitar", "hip-hop", "edm", "dance", "comedy", "satisfying", "art", "design",
  "photography", "fashion", "diy", "history", "philosophy", "psychology", "productivity",
  "business", "finance", "books", "chess", "magic", "extreme-sports", "life-hacks",
];
