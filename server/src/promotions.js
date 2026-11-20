// Promoted clips: a clip the operator runs as an ad at the top of every viewer's feed for a set
// period, with a link to its creator's channel. Each viewer has to watch it through once before
// they can scroll on; after that it still opens their feed but can be skipped like any clip.
//
// Configured in server/promotions.json (committed, so every change is reviewable and deploys with
// a push): [{ url, from, until, label?, channelUrl?, ctaLabel? }]. Only YouTube links are accepted,
// because YouTube clips play through the official player without axol holding a copy.
//
// A promoted clip is always labelled as promoted. It is never presented as a personal pick, and
// watching it teaches the viewer's taste profile nothing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, q, uid, now, transaction } from "./db.js";
import { PLAYABLE } from "./ranker.js";
import { publicVideo } from "./videoView.js";
import { youtube } from "./sources/youtube.js";
import { upsertVideos, tagPending } from "./ingest.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = process.env.AXOL_PROMOTIONS_FILE || path.join(here, "..", "promotions.json");

db.exec(`CREATE TABLE IF NOT EXISTS promotions (
  video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  cta_label TEXT NOT NULL,
  cta_url TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL
)`);

/** Read the config, make sure each clip is in the catalog, and store the schedule. Runs at boot. */
export async function loadPromotions() {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(CONFIG, "utf8")); } catch { list = []; }
  const keep = [];
  for (const p of Array.isArray(list) ? list : []) {
    const ref = youtube.fromUrl(String(p.url || ""));
    const startsAt = Date.parse(p.from || "") || now(), endsAt = Date.parse(p.until || "");
    if (!ref || !endsAt) { console.warn("[promotions] skipped an entry: needs a YouTube url and an until date"); continue; }
    try {
      const meta = await youtube.lookup(ref.external_id); // title, creator, channel link, duration
      if (meta && meta.playable === false) { console.warn(`[promotions] ${ref.external_id} cannot be embedded; skipped`); continue; }
      const fresh = upsertVideos([{ ...ref, ...(meta ? { title: meta.title, creator: meta.creator, thumbnail: meta.thumbnail, duration_ms: meta.duration_ms, description: meta.description } : {}), query: "" }]);
      await tagPending(fresh);
      const video = q.get("SELECT id, creator FROM videos WHERE source = 'youtube' AND external_id = ?", ref.external_id);
      const prior = q.get("SELECT cta_url FROM promotions WHERE video_id = ?", video.id);
      const channelUrl = p.channelUrl || meta?.channelUrl || prior?.cta_url || ref.url;
      const creator = (meta?.creator || video.creator || "").trim();
      const ctaLabel = p.ctaLabel || (creator ? `Subscribe to ${creator} on YouTube` : "Subscribe on YouTube");
      q.run(`INSERT INTO promotions (video_id, label, cta_label, cta_url, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(video_id) DO UPDATE SET label = excluded.label, cta_label = excluded.cta_label, cta_url = excluded.cta_url, starts_at = excluded.starts_at, ends_at = excluded.ends_at`,
        video.id, p.label || "Promoted", ctaLabel, subscribeUrl(channelUrl), startsAt, endsAt);
      keep.push(video.id);
    } catch (e) {
      console.warn(`[promotions] ${ref.external_id}: ${e.message}`);
      const video = q.get("SELECT id FROM videos WHERE source = 'youtube' AND external_id = ?", ref.external_id);
      if (video) keep.push(video.id); // keep an existing schedule if the lookup failed this time
    }
  }
  // The file is the source of truth: a promotion removed from it stops.
  for (const row of q.all("SELECT video_id FROM promotions")) if (!keep.includes(row.video_id)) q.run("DELETE FROM promotions WHERE video_id = ?", row.video_id);
  return keep.length;
}

/** The label on a member's earned ad (see referrals.js). */
export const SPONSORED = "Sponsored";

// A channel link that opens YouTube's own "subscribe?" prompt.
export function subscribeUrl(url) {
  try { const u = new URL(url); if (/(^|\.)youtube\.com$/.test(u.hostname) && /^\/(@|channel\/|c\/)/.test(u.pathname)) u.searchParams.set("sub_confirmation", "1"); return u.toString(); } catch { return url; }
}

/** True when this impression is a promoted placement (so it is kept out of learning). */
export function isPromoImpression(imp) {
  if (imp.reason === SPONSORED) return !!q.get("SELECT 1 FROM ads WHERE video_id = ?", imp.video_id);
  return !!q.get("SELECT 1 FROM promotions WHERE video_id = ? AND label = ?", imp.video_id, imp.reason);
}

/** Promotions running right now, soonest-ending first, with their clips. */
export function activePromotions(at = now()) {
  return q.all(`SELECT p.label, p.cta_label, p.cta_url, p.starts_at, p.ends_at, v.* FROM promotions p JOIN videos v ON v.id = p.video_id
                WHERE p.starts_at <= ? AND p.ends_at > ? AND v.tagged = 1 AND ${PLAYABLE} ORDER BY p.ends_at`, at, at);
}

/**
 * The clips that open a viewer's feed. A promoted clip leads every session while it runs.
 * `mustWatch` is set until the viewer has watched it through once; the player holds the feed on
 * it until then. Once they have, they may tap "Not me" and it stops appearing for them.
 */
export function openingItems(userId, at = now()) {
  const promos = activePromotions(at).filter((p) => !q.get("SELECT 1 FROM impressions WHERE user_id = ? AND video_id = ? AND hidden = 1 LIMIT 1", userId, p.id));
  if (!promos.length) return [];
  const ins = db.prepare("INSERT INTO impressions (id, user_id, video_id, served_at, duration_ms, reason, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  return transaction(() => promos.map((p) => {
    const id = uid();
    ins.run(id, userId, p.id, at, p.duration_ms, p.label, at);
    const item = { ...publicVideo(p), topics: [] }; // no steering from an ad
    const seen = q.get("SELECT 1 FROM impressions WHERE user_id = ? AND video_id = ? AND watched_ms >= ? LIMIT 1", userId, p.id, Math.round(0.9 * (p.duration_ms || 20000)));
    const until = new Date(p.ends_at).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
    return {
      impressionId: id, reason: p.label, ...item,
      why: { kind: "promoted", label: p.label, topic: null, clipTopics: [],
        detail: `This is a promotion. axol shows it to everyone until ${until}, and everyone watches it through once. It was not picked from your history and it does not change your feed.` },
      promo: { label: p.label, until: p.ends_at, mustWatch: !seen, cta: { label: p.cta_label, url: p.cta_url } },
    };
  }));
}

/** How each running promotion is doing, for the health report. */
export function promotionStats(at = now()) {
  return activePromotions(at).map((p) => {
    const s = q.get(`SELECT COUNT(*) AS shown, COUNT(DISTINCT user_id) AS viewers, SUM(CASE WHEN watched_ms > 0 THEN 1 ELSE 0 END) AS played,
                            SUM(CASE WHEN watched_ms >= 0.9 * MAX(duration_ms, 1) THEN 1 ELSE 0 END) AS finished, SUM(liked) AS likes
                     FROM impressions WHERE video_id = ? AND served_at >= ?`, p.id, p.starts_at);
    const clicks = q.get(`SELECT COUNT(*) AS n FROM events e JOIN impressions i ON i.id = e.impression_id WHERE e.type = 'cta' AND i.video_id = ? AND e.created_at >= ?`, p.id, p.starts_at)?.n || 0;
    return { title: p.title, creator: (p.creator || "").trim(), channel: p.cta_url, until: new Date(p.ends_at).toISOString(), shown: s.shown, viewers: s.viewers, played: s.played || 0, finished: s.finished || 0, likes: s.likes || 0, channelClicks: clicks };
  });
}
