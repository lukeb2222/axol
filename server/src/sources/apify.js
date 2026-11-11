// Apify discovery provider for TikTok and Instagram.
// Set APIFY_TOKEN on the server. Runs are asynchronous: start → poll → read dataset,
// which keeps request lifetimes short and survives slow scrapes.
//
// Actors (verified input schemas, Nov 2026):
//   clockworks/tiktok-scraper      searchQueries + searchSection "/video"  (pay per event, ~$0.0002/video)
//   apify/instagram-hashtag-scraper keywordSearch + resultsType "reels"     (~10s per query)
// Every run is started with a hard spend cap (APIFY_MAX_USD_PER_RUN, default $0.50, the minimum Apify accepts).
import { config } from "../config.js";
import { q } from "../db.js";

// Daily run budget: each run costs roughly 1-2 cents, so this bounds spend.
const today = () => new Date().toISOString().slice(0, 10);
export const apifyRunsToday = () => q.get("SELECT units FROM quota_ledger WHERE source = 'apify' AND day = ?", today())?.units || 0;
export class ApifyBudgetError extends Error { constructor() { super("Apify daily run budget reached; TikTok/Instagram discovery resumes tomorrow"); this.quota = true; } }
function spendRun() {
  if (apifyRunsToday() >= config.apifyDailyRuns) throw new ApifyBudgetError();
  q.run("INSERT INTO quota_ledger (source, day, units) VALUES ('apify', ?, 1) ON CONFLICT(source, day) DO UPDATE SET units = units + 1", today());
}

const API = "https://api.apify.com/v2";
const MAX_WAIT_MS = 150e3;

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
export async function runActor(actor, input, { timeoutSec = 120, memory = 1024, limit = 100 } = {}) {
  spendRun();
  const cap = config.apifyMaxUsdPerRun;
  const { data: run } = await api(`/acts/${actor}/runs?memory=${memory}&timeout=${timeoutSec}&maxTotalChargeUsd=${cap}`, { method: "POST", body: input });
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
    // Apify stores each video file in a named key-value store (named stores are kept, not expired).
    ...(config.apifyDownloadTikTok ? { shouldDownloadVideos: true, videoKvStoreIdOrName: config.apifyVideoStore } : {}),
  }, { limit: max, timeoutSec: 180 });
  return items
    .filter((v) => v.webVideoUrl && !v.isSlideshow)
    .map((v) => ({
      url: v.webVideoUrl,
      title: (v.text || "").slice(0, 200),
      creator: v.authorMeta?.name ? `@${v.authorMeta.name}` : "",
      thumbnail: v.videoMeta?.coverUrl || "",
      duration_ms: Math.round((v.videoMeta?.duration || 0) * 1000),
      hashtags: (v.hashtags || []).map((h) => (typeof h === "object" ? h.name : h)).filter(Boolean),
      media_src: (v.mediaUrls || []).find((u) => /^https:\/\/api\.apify\.com\/.+\.mp4/.test(u)) || "",
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
  // A short-lived link to the reel's file; it is downloaded straight after discovery.
  media_src: typeof p.videoUrl === "string" && p.videoUrl.startsWith("https://") ? p.videoUrl : "",
});
const isReel = (p) => p.type === "Video" || p.productType === "clips" || !!p.videoUrl || !!p.videoDuration;

export async function instagramSearch(query, { max = 12 } = {}) {
  const tag = query.replace(/^#/, "").trim().toLowerCase();
  const n = Math.min(30, max);
  // Keyword reels search is the reliable route (verified: ~10s per query). Plain hashtag
  // pages are blocked by Instagram intermittently, so they are only the second attempt.
  // Deliberately no profile-scraping fallback: it is slow and costs dollars per run.
  const attempts = [
    { hashtags: [tag], keywordSearch: true, resultsType: "reels", resultsLimit: n },
    { hashtags: [tag.replace(/\s+/g, "")], resultsType: "reels", resultsLimit: n },
  ];
  for (const input of attempts) {
    try {
      const items = await runActor("apify~instagram-hashtag-scraper", input, { limit: max, timeoutSec: 90 });
      const reels = items.filter(isReel).map(normalizeReel).filter((r) => r.url);
      if (reels.length) return reels;
    } catch (e) {
      if (e.quota) throw e;
      console.warn(`[apify] instagram "${tag}": ${e.message}`);
    }
  }
  return [];
}

/** Fetch downloadable files for TikTok clips already in the catalog. Returns Map(postId -> file URL). */
export async function tiktokFiles(urls) {
  const items = await runActor("clockworks~tiktok-scraper", {
    postURLs: urls, resultsPerPage: 1, proxyCountryCode: "None", shouldDownloadVideos: true, videoKvStoreIdOrName: config.apifyVideoStore,
  }, { limit: urls.length, timeoutSec: 240 });
  const out = new Map();
  for (const v of items) {
    const file = (v.mediaUrls || []).find((u) => /^https:\/\/api\.apify\.com\/.+\.mp4/.test(u));
    if (v.id && file) out.set(String(v.id), file);
  }
  return out;
}
