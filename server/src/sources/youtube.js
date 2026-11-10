// YouTube Shorts adapter. Uses the official Data API v3 (free quota: ~100 searches/day)
// to find short vertical videos and their durations; playback uses the official IFrame
// Player. Without YOUTUBE_API_KEY, automated discovery is off and clips only arrive via
// pasted links (fromUrl) or the generic discovery provider.
import { config } from "../config.js";
import { q, now } from "../db.js";

const API = "https://www.googleapis.com/youtube/v3";
const UNITS = { search: 100, list: 1 };

function today() { return new Date().toISOString().slice(0, 10); }
export function youtubeUnitsUsed() { return q.get("SELECT units FROM quota_ledger WHERE source = 'youtube' AND day = ?", today())?.units || 0; }
function spend(units) {
  if (youtubeUnitsUsed() + units > config.youtubeDailyUnits) throw new QuotaError();
  q.run(`INSERT INTO quota_ledger (source, day, units) VALUES ('youtube', ?, ?) ON CONFLICT(source, day) DO UPDATE SET units = units + excluded.units`, today(), units);
}
export class QuotaError extends Error { constructor() { super("YouTube daily quota budget reached; discovery resumes tomorrow"); this.quota = true; } }

async function yt(path, params, units) {
  spend(units);
  const res = await fetch(`${API}/${path}?${new URLSearchParams({ ...params, key: config.youtubeApiKey })}`, { signal: AbortSignal.timeout(15000) });
  if (res.status === 403) {
    const body = await res.text();
    if (/quota/i.test(body)) { q.run("UPDATE quota_ledger SET units = ? WHERE source = 'youtube' AND day = ?", config.youtubeDailyUnits, today()); throw new QuotaError(); }
    throw new Error(`YouTube ${path} 403: ${body.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`YouTube ${path} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function normalize(v, query) {
  return {
    source: "youtube",
    external_id: v.id,
    embed_kind: "youtube",
    url: `https://www.youtube.com/shorts/${v.id}`,
    title: v.snippet?.title || "",
    creator: v.snippet?.channelTitle || "",
    description: v.snippet?.description || "",
    thumbnail: v.snippet?.thumbnails?.high?.url || v.snippet?.thumbnails?.default?.url || "",
    duration_ms: isoDurationMs(v.contentDetails?.duration),
    query,
  };
}
const isShort = (v) => v.duration_ms > 0 && v.duration_ms <= 3 * 60 * 1000;

export const youtube = {
  name: "youtube",
  mode: () => (config.youtubeApiKey ? "api" : "links-only"),
  canDiscover: () => !!config.youtubeApiKey,

  async search(query, { max = 12 } = {}) {
    if (!config.youtubeApiKey) {
      warnOnce();
      return [];
    }
    const data = await yt("search", {
      part: "snippet", q: `${query} #shorts`, type: "video", videoDuration: "short", videoEmbeddable: "true",
      safeSearch: "moderate", maxResults: String(Math.min(50, max)), order: "relevance",
    }, UNITS.search);
    const ids = (data.items || []).map((i) => i.id?.videoId).filter(Boolean);
    if (!ids.length) return [];
    const details = await yt("videos", { part: "snippet,contentDetails", id: ids.join(",") }, UNITS.list);
    return (details.items || []).map((v) => normalize(v, query)).filter(isShort);
  },

  /**
   * Cheap catalog filler (1 unit per call vs 100 for search): most-popular videos in a
   * category, filtered down to short-form. Used by warm-up and when the search budget is spent.
   */
  async trending(categoryId, label, { region = "US" } = {}) {
    if (!config.youtubeApiKey) return [];
    const data = await yt("videos", { part: "snippet,contentDetails", chart: "mostPopular", regionCode: region, videoCategoryId: String(categoryId), maxResults: "50" }, UNITS.list);
    return (data.items || []).map((v) => normalize(v, label)).filter(isShort);
  },

  /** Build an item from a pasted URL (watch, shorts, youtu.be). */
  fromUrl(url) {
    const m = url.match(/(?:youtube\.com\/(?:shorts\/|watch\?v=)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
    if (!m) return null;
    return {
      source: "youtube", external_id: m[1], embed_kind: "youtube",
      url: `https://www.youtube.com/shorts/${m[1]}`, title: "", creator: "", description: "",
      thumbnail: `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg`, duration_ms: 0, query: "",
    };
  },
};

let warned = false;
function warnOnce() {
  if (warned) return;
  warned = true;
  console.warn("[youtube] YOUTUBE_API_KEY not set: automated Shorts discovery is off (paste links or configure a provider)");
}

/** Public oEmbed (no key) fills in title/creator for pasted links. */
youtube.enrich = async function enrich(item) {
  if (item.title) return item;
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(item.url)}&format=json`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return item;
    const d = await res.json();
    return { ...item, title: d.title || item.title, creator: d.author_name || item.creator, thumbnail: d.thumbnail_url || item.thumbnail };
  } catch {
    return item;
  }
};

export function isoDurationMs(iso) {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000;
}
