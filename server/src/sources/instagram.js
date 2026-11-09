// Instagram Reels adapter. Playback uses Instagram's public /embed endpoint.
// Discovery requires a provider (see provider.js) or user-imported URLs.
import { config } from "../config.js";
import { providerSearch } from "./provider.js";

const URL_RE = /instagram\.com\/(?:[\w.]+\/)?(reel|reels|p)\/([A-Za-z0-9_-]+)/;

export const instagram = {
  name: "instagram",
  mode: () => "embed",

  async search(query, opts) {
    const rows = await providerSearch("instagram", query, opts);
    const items = [];
    for (const r of rows) {
      const it = instagram.fromUrl(r.url);
      if (it) items.push({ ...it, title: r.title || it.title, creator: r.creator || it.creator, query });
    }
    return items;
  },

  fromUrl(url) {
    const m = String(url).match(URL_RE);
    if (!m) return null;
    return {
      source: "instagram", external_id: m[2], embed_kind: "instagram",
      url: `https://www.instagram.com/reel/${m[2]}/`,
      title: "", creator: "", description: "", thumbnail: "", duration_ms: 0, query: "",
    };
  },

  /** Official oEmbed needs a Facebook app token; skipped when absent. */
  async enrich(item) {
    if (!config.instagramOembedToken) return item;
    try {
      const u = `https://graph.facebook.com/v19.0/instagram_oembed?url=${encodeURIComponent(item.url)}&access_token=${config.instagramOembedToken}`;
      const res = await fetch(u, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return item;
      const d = await res.json();
      return { ...item, title: d.title || item.title, creator: d.author_name ? `@${d.author_name}` : item.creator, thumbnail: d.thumbnail_url || item.thumbnail };
    } catch {
      return item;
    }
  },
};
