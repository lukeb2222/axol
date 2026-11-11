// Central configuration. Everything is optional; the app degrades gracefully.
import path from "node:path";
import { fileURLToPath } from "node:url";

import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));

// Load server/keys.env (KEY=value lines) without overriding real environment variables.
try {
  for (const line of fs.readFileSync(path.join(here, "..", "keys.env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !m[2].startsWith("#") && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

export const config = {
  port: Number(process.env.PORT || 3000),
  dbPath: process.env.AXOL_DB_PATH || path.join(here, "..", "data", "axol.sqlite"),
  webDist: path.join(here, "..", "..", "web", "dist"),

  // AI (Anthropic). When no credentials resolve, heuristics are used instead.
  model: process.env.AXOL_MODEL || "claude-opus-5-5",
  // Optional per-task overrides (default to AXOL_MODEL). Tagging is high-volume classification.
  modelTagger: process.env.AXOL_MODEL_TAGGER || process.env.AXOL_MODEL || "claude-opus-5-5",
  modelOnboarding: process.env.AXOL_MODEL_ONBOARDING || process.env.AXOL_MODEL || "claude-opus-5-5",
  // Hard monthly ceiling on AI spend, tracked from each response's token usage. When reached,
  // the app falls back to heuristics until the next calendar month.
  aiMonthlyUsd: Number(process.env.AXOL_AI_MONTHLY_USD || 10),
  aiDisabled: process.env.AXOL_DISABLE_AI === "1",

  // Content sources
  youtubeApiKey: process.env.YOUTUBE_API_KEY || "",
  // Daily YouTube Data API budget in quota units (Google's free tier is 10,000/day; search = 100, list = 1).
  youtubeDailyUnits: Number(process.env.YOUTUBE_DAILY_UNITS || 9000),
  // Pre-fill the catalog on boot so new users never see an empty feed. Set AXOL_WARMUP=0 to disable.
  warmup: process.env.AXOL_WARMUP !== "0",
  // Optional JSON endpoint that returns [{ "url": "https://www.tiktok.com/@x/video/123" }, ...]
  // for a query. Receives ?q=<query>&source=tiktok|instagram. Lets you plug in a licensed
  // discovery provider without changing app code.
  discoveryProviderUrl: process.env.AXOL_DISCOVERY_PROVIDER_URL || "",
  discoveryProviderToken: process.env.AXOL_DISCOVERY_PROVIDER_TOKEN || "",
  instagramOembedToken: process.env.IG_OEMBED_TOKEN || "",
  // Apify token enables automated TikTok and Instagram discovery (see sources/apify.js).
  apifyToken: process.env.APIFY_TOKEN || "",
  // Runs per day across TikTok + Instagram. 10/day is roughly $4-5/month, inside Apify's free credit.
  apifyDailyRuns: Number(process.env.APIFY_DAILY_RUNS || 10),
  apifyMaxUsdPerRun: Number(process.env.APIFY_MAX_USD_PER_RUN || 0.5),

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
    queryCacheMs: 24 * 3600e3, // a query run by anyone within this window is not re-run for someone else
  },
};
