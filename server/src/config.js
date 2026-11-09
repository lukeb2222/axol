// Central configuration. Everything is optional; the app degrades gracefully.
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.PORT || 3000),
  dbPath: process.env.AXOL_DB_PATH || path.join(here, "..", "data", "axol.sqlite"),
  webDist: path.join(here, "..", "..", "web", "dist"),

  // AI (Anthropic). When no credentials resolve, heuristics are used instead.
  model: process.env.AXOL_MODEL || "claude-opus-5-5",
  aiDisabled: process.env.AXOL_DISABLE_AI === "1",

  // Content sources
  youtubeApiKey: process.env.YOUTUBE_API_KEY || "",
  // Optional JSON endpoint that returns [{ "url": "https://www.tiktok.com/@x/video/123" }, ...]
  // for a query. Receives ?q=<query>&source=tiktok|instagram. Lets you plug in a licensed
  // discovery provider without changing app code.
  discoveryProviderUrl: process.env.AXOL_DISCOVERY_PROVIDER_URL || "",
  discoveryProviderToken: process.env.AXOL_DISCOVERY_PROVIDER_TOKEN || "",
  instagramOembedToken: process.env.IG_OEMBED_TOKEN || "",

  // Learning hyper-parameters
  learning: {
    rate: 0.18,          // how fast a single view moves an interest weight
    maxWeight: 5,        // weights saturate here (soft ceiling)
    decay: 0.995,        // multiplicative decay applied to all weights per event
    neutralCompletion: 0.45, // watching 45% of a clip is "neutral"; more is positive
    quickSkipMs: 2500,   // leaving before this counts as a hard skip
    resynthEvery: 12,    // events between AI profile re-synthesis
  },

  ranking: {
    batchSize: 8,
    exploreWeight: 0.35,
    freshnessWeight: 0.2,
    diversityPenalty: 0.3,
    noise: 0.08,
    minPool: 12,         // trigger discovery when unseen pool is smaller than this
  },
};
