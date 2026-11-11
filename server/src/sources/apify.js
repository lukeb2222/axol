// Apify discovery provider for TikTok and Instagram.
// Set APIFY_TOKEN on the server. Runs are asynchronous: start → poll → read dataset,
// which keeps request lifetimes short and survives slow scrapes.
//
// Actors (verified input schemas, Nov 2026):
//   clockworks/tiktok-scraper      searchQueries + searchSection "/video"  (pay per event, ~$0.0002/video)
//   apify/instagram-hashtag-scraper hashtags + resultsType "reels"          (Instagram blocks this intermittently)
//   apify/instagram-scraper         search/searchType "user" → profiles       (fallback route, step 1)
//   apify/instagram-reel-scraper    username[] → reels                       (fallback route, step 2)
import { config } from "../config.js";

const API = "https://api.apify.com/v2";
const MAX_WAIT_MS = 240e3;

export const apifyEnabled = () => !!config.apifyToken;

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${config.apifyToken}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30e3),
  });
  if (!res.ok) throw new Error(`apify ${method} ${path.split("?")[0]} → ${res.status} ${(await res.text()).slice(0, 160)}`);
  return res.json();
}

/** Run an actor to completion and return its dataset items. */
export async function runActor(actor, input, { timeoutSec = 240, memory = 1024, limit = 100 } = {}) {
  const { data: run } = await api(`/acts/${actor}/runs?memory=${memory}&timeout=${timeoutSec}`, { method: "POST", body: input });
  if (!run?.id) throw new Error(`apify: could not start ${actor}`);
  const started = Date.now();
  while (Date.now() - started < MAX_WAIT_MS) {
    await new Promise((r) => setTimeout(r, 4000));
    const { data: st } = await api(`/actor-runs/${run.id}`);
    if (["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(st.status)) {
      const items = await api(`/datasets/${st.defaultDatasetId}/items?clean=true&limit=${limit}`);
      if (st.status !== "SUCCEEDED") console.warn(`[apify] ${actor} ${st.status}`);
      return Array.isArray(items) ? items.filter((i) => !i.error) : [];
    }
  }
  api(`/actor-runs/${run.id}/abort`, { method: "POST" }).catch(() => {});
  throw new Error(`apify: ${actor} did not finish in ${MAX_WAIT_MS / 1000}s`);
}

/* --------------------------------- TikTok ---------------------------------- */

export async function tiktokSearch(query, { max = 12 } = {}) {
  const items = await runActor("clockworks~tiktok-scraper", {
    searchQueries: [query], searchSection: "/video", resultsPerPage: Math.min(30, max), proxyCountryCode: "None",
  }, { limit: max });
  return items
    .filter((v) => v.webVideoUrl && !v.isSlideshow)
    .map((v) => ({
      url: v.webVideoUrl,
      title: (v.text || "").slice(0, 200),
      creator: v.authorMeta?.name ? `@${v.authorMeta.name}` : "",
      thumbnail: v.videoMeta?.coverUrl || "",
      duration_ms: Math.round((v.videoMeta?.duration || 0) * 1000),
      hashtags: (v.hashtags || []).map((h) => (typeof h === "object" ? h.name : h)).filter(Boolean),
    }))
    .filter((v) => v.duration_ms === 0 || v.duration_ms <= 3 * 60e3);
}

/* -------------------------------- Instagram -------------------------------- */

const normalizeReel = (p) => ({
  url: p.url || (p.shortCode ? `https://www.instagram.com/reel/${p.shortCode}/` : ""),
  title: (p.caption || "").slice(0, 200),
  creator: p.ownerUsername ? `@${p.ownerUsername}` : "",
  thumbnail: p.displayUrl || "",
  duration_ms: Math.round((p.videoDuration || 0) * 1000),
  hashtags: p.hashtags || [],
});
const isReel = (p) => p.type === "Video" || p.productType === "clips" || !!p.videoUrl || !!p.videoDuration;

export async function instagramSearch(query, { max = 12 } = {}) {
  const tag = query.replace(/^#/, "").replace(/\s+/g, "").toLowerCase();
  // Route 1: hashtag reels (fast when Instagram allows it).
  try {
    const items = await runActor("apify~instagram-hashtag-scraper", { hashtags: [tag], resultsType: "reels", resultsLimit: Math.min(30, max) }, { limit: max });
    const reels = items.filter(isReel).map(normalizeReel).filter((r) => r.url);
    if (reels.length) return reels;
  } catch (e) {
    console.warn(`[apify] instagram hashtag "${tag}": ${e.message}`);
  }
  // Route 2: top creators for the topic → their recent reels.
  const profiles = await runActor("apify~instagram-scraper", { search: query, searchType: "user", searchLimit: 3 }, { limit: 5 }).catch(() => []);
  const usernames = profiles.map((p) => p.username).filter(Boolean).slice(0, 3);
  if (!usernames.length) return [];
  const reels = await runActor("apify~instagram-reel-scraper", { username: usernames, resultsLimit: Math.ceil(max / usernames.length) }, { limit: max });
  return reels.filter(isReel).map(normalizeReel).filter((r) => r.url);
}
