// TikTok adapter. Playback uses TikTok's public embed player (no key needed).
// Discovery requires a provider (see provider.js) or user-imported URLs, because
// TikTok does not offer a public search API to third-party apps.
import { providerSearch } from "./provider.js";

const URL_RE = /tiktok\.com\/@([\w.-]+)\/video\/(\d+)/;

export const tiktok = {
  name: "tiktok",
  mode: () => "embed",

  async search(query, opts) {
    const rows = await providerSearch("tiktok", query, opts);
    const items = [];
    for (const r of rows) {
      const it = tiktok.fromUrl(r.url);
      if (it) items.push({ ...it, title: r.title || it.title, creator: r.creator || it.creator, query });
    }
    return items;
  },

  fromUrl(url) {
    const m = String(url).match(URL_RE);
    if (!m) return null;
    return {
      source: "tiktok", external_id: m[2], embed_kind: "tiktok",
      url: `https://www.tiktok.com/@${m[1]}/video/${m[2]}`,
      title: "", creator: `@${m[1]}`, description: "", thumbnail: "", duration_ms: 0, query: "",
    };
  },

  /** Public oEmbed enriches title/creator/thumbnail when reachable. */
  async enrich(item) {
    try {
      const res = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(item.url)}`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return item;
      const d = await res.json();
      return { ...item, title: d.title || item.title, creator: d.author_name ? `@${d.author_name}` : item.creator, thumbnail: d.thumbnail_url || item.thumbnail };
    } catch {
      return item;
    }
  },
};
