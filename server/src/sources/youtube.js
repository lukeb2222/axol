// YouTube Shorts adapter. Uses the official Data API v3 (free quota: ~100 searches/day)
// to find short vertical videos and their durations; playback uses the official IFrame
// Player. Without YOUTUBE_API_KEY, automated discovery is off and clips only arrive via
// pasted links (fromUrl) or the generic discovery provider.
import { config } from "../config.js";

const API = "https://www.googleapis.com/youtube/v3";

export const youtube = {
  name: "youtube",
  mode: () => (config.youtubeApiKey ? "api" : "links-only"),

  async search(query, { max = 12 } = {}) {
    if (!config.youtubeApiKey) {
      warnOnce();
      return [];
    }
    const params = new URLSearchParams({
      part: "snippet",
      q: `${query} #shorts`,
      type: "video",
      videoDuration: "short",
      videoEmbeddable: "true",
      safeSearch: "moderate",
      maxResults: String(Math.min(50, max)),
      order: "relevance",
      key: config.youtubeApiKey,
    });
    const res = await fetch(`${API}/search?${params}`);
    if (!res.ok) throw new Error(`YouTube search failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    const ids = (data.items || []).map((i) => i.id?.videoId).filter(Boolean);
    if (!ids.length) return [];
    const det = await fetch(`${API}/videos?${new URLSearchParams({ part: "snippet,contentDetails", id: ids.join(","), key: config.youtubeApiKey })}`);
    if (!det.ok) throw new Error(`YouTube videos.list failed: ${det.status}`);
    const details = await det.json();
    return (details.items || [])
      .map((v) => ({
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
      }))
      .filter((v) => v.duration_ms > 0 && v.duration_ms <= 3 * 60 * 1000);
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
