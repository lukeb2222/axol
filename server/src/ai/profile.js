import { z } from "zod";
import { structured } from "./claude.js";
import { TAXONOMY, extractTags, normalizeTag } from "./taxonomy.js";

const SOURCES = ["youtube", "tiktok", "instagram"];

const InterestSchema = z.object({
  tag: z.string().describe("short kebab-case topic tag, e.g. 'skateboarding' or 'street-food'"),
  weight: z.number().min(0).max(1).describe("how central this is to the person, 0-1"),
  why: z.string().describe("one short clause grounded in what they said"),
});

const QueriesSchema = z.object({
  youtube: z.array(z.string()).describe("6-10 YouTube Shorts search queries, specific and varied"),
  tiktok: z.array(z.string()).describe("6-10 TikTok hashtags or search phrases without #"),
  instagram: z.array(z.string()).describe("6-10 Instagram Reels hashtags or phrases without #"),
});

const InitialProfileSchema = z.object({
  summary: z.string().describe("2-3 sentence warm, specific description of this person's taste, written to them in second person"),
  interests: z.array(InterestSchema).min(3).max(20),
  adjacent: z.array(InterestSchema).max(8).describe("things they didn't say but will probably love; lower weights"),
  avoid: z.array(z.string()).describe("topics to keep out of the feed, from explicit dislikes only"),
  queries: QueriesSchema,
});

const ResynthSchema = z.object({
  summary: z.string().describe("updated 2-3 sentence description of their taste in second person; mention what changed"),
  adjustments: z.array(z.object({
    tag: z.string(),
    delta: z.number().min(-1).max(1).describe("signed nudge to the interest weight"),
    reason: z.string(),
  })).max(15),
  new_interests: z.array(InterestSchema).max(6).describe("interests to introduce for exploration"),
  queries: QueriesSchema,
  insight: z.string().describe("one punchy sentence shown to the user about what the feed just learned"),
});

const PROFILE_SYSTEM = `You are the taste engine for axol, a short-video feed where every clip is chosen for one person.
You turn what a person says about themselves into a precise interest profile and content-discovery queries.
Rules:
- Tags are short kebab-case topics. Prefer specific over generic (e.g. "sourdough-baking" over "food").
- Weights reflect centrality. Something mentioned first or with enthusiasm is higher.
- "adjacent" interests are tasteful guesses that broaden the feed; keep weights 0.2-0.5.
- Queries must find real short-form vertical video. Mix formats: tutorials, POV, highlights, satisfying, comedy within their topics.
- Never invent dislikes. "avoid" only contains what they explicitly do not want.`;

const RESYNTH_SYSTEM = `You are the taste engine for axol, a short-video feed where every clip is chosen for one person.
You are given their current interest weights and their recent viewing behaviour (how much of each clip they watched, likes, skips).
Infer what is actually holding their attention versus what they merely said. Reward watch-through and replays heavily; treat quick skips as a clear negative signal for the clip's tags.
Produce weight adjustments, a few new exploratory interests that are plausible given the pattern, and fresh discovery queries that lean into what is working while still exploring.
Keep tags kebab-case and consistent with the existing ones when they refer to the same thing.`;

/* -------------------------------------------------------------------------- */

export async function buildInitialProfile({ text, chips }) {
  const user = `What they wrote about their passions, interests and what they want to see:\n"""${text}"""\n\nTags they picked from a list: ${chips.length ? chips.join(", ") : "(none)"}`;
  const ai = await structured({ schema: InitialProfileSchema, system: PROFILE_SYSTEM, user, effort: "medium" });
  if (ai) return { ...clean(ai), mode: "ai" };
  return { ...heuristicInitial(text, chips), mode: "heuristic" };
}

export async function resynthesize({ interests, recent, summary }) {
  const table = interests
    .slice(0, 40)
    .map((i) => `${i.tag}: weight=${i.weight.toFixed(2)} views=${i.impressions} positive=${i.positive}`)
    .join("\n");
  const history = recent
    .map((r) => {
      const pct = Math.round((r.completion || 0) * 100);
      const flags = [r.liked && "LIKED", r.replays > 0 && `replayed x${r.replays}`, r.skipped && "SKIPPED", r.hidden && "HIDDEN"].filter(Boolean).join(", ");
      return `- [${r.source}] "${r.title}" tags=${r.tags.join(",")} watched=${pct}%${flags ? " " + flags : ""}`;
    })
    .join("\n");
  const user = `Previous summary: ${summary || "(none)"}\n\nCurrent interests:\n${table}\n\nRecent viewing (newest last):\n${history}`;
  const ai = await structured({ schema: ResynthSchema, system: RESYNTH_SYSTEM, user, effort: "medium" });
  if (ai) {
    return {
      summary: ai.summary,
      adjustments: ai.adjustments.map((a) => ({ ...a, tag: normalizeTag(a.tag) })).filter((a) => a.tag),
      newInterests: ai.new_interests.map((i) => ({ ...i, tag: normalizeTag(i.tag) })).filter((i) => i.tag),
      queries: cleanQueries(ai.queries),
      insight: ai.insight,
      mode: "ai",
    };
  }
  return heuristicResynth({ interests, recent, summary });
}

/* ------------------------------ heuristics -------------------------------- */

function clean(p) {
  const norm = (arr) => arr.map((i) => ({ ...i, tag: normalizeTag(i.tag) })).filter((i) => i.tag);
  return {
    summary: p.summary,
    interests: norm(p.interests),
    adjacent: norm(p.adjacent),
    avoid: p.avoid.map(normalizeTag).filter(Boolean),
    queries: cleanQueries(p.queries),
  };
}

function cleanQueries(qs) {
  const out = {};
  for (const s of SOURCES) {
    const list = (qs?.[s] || []).map((x) => String(x).replace(/^#/, "").trim()).filter(Boolean);
    out[s] = [...new Set(list)].slice(0, 10);
  }
  return out;
}

export function heuristicInitial(text, chips) {
  const hits = extractTags(text);
  for (const c of chips) hits.set(normalizeTag(c), (hits.get(normalizeTag(c)) || 0) + 2);
  // Fallback when nothing matched: split on commas/newlines.
  if (hits.size === 0) {
    for (const part of String(text).split(/[,\n;]|\band\b/)) {
      const tag = normalizeTag(part);
      if (tag && tag.length > 2) hits.set(tag, 1);
    }
  }
  const max = Math.max(1, ...hits.values());
  const interests = [...hits.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 16)
    .map(([tag, n]) => ({ tag, weight: 0.4 + 0.6 * (n / max), why: "mentioned in your intro" }));
  const avoid = [];
  for (const m of String(text).matchAll(/\b(?:no|not|don't want|dont want|hate|avoid|without|less)\b\s+([a-z\s-]{3,30})/gi)) {
    const found = [...extractTags(m[1]).keys()];
    if (found.length) avoid.push(...found);
    else {
      const first = normalizeTag(m[1].trim().split(/\s+/)[0]);
      if (first && first.length > 3 && !/^(please|thanks|really|too|much|more|the|any)$/.test(first)) avoid.push(first);
    }
  }
  const queries = queriesFromTags(interests.map((i) => i.tag));
  return {
    summary: `You're into ${interests.slice(0, 3).map((i) => i.tag.replace(/-/g, " ")).join(", ")}${interests.length > 3 ? " and more" : ""}. Your feed starts there and reshapes itself around what actually holds your attention.`,
    interests,
    adjacent: [],
    avoid,
    queries,
  };
}

export function queriesFromTags(tags) {
  const words = tags.map((t) => t.replace(/-/g, " "));
  return {
    youtube: words.map((w) => `${w} shorts`).slice(0, 10),
    tiktok: words.map((w) => w.replace(/\s+/g, "")).slice(0, 10),
    instagram: words.map((w) => w.replace(/\s+/g, "")).slice(0, 10),
  };
}

export function heuristicResynth({ interests, recent, summary }) {
  // Find tags that over/under-perform relative to the user's average completion.
  const avg = recent.length ? recent.reduce((s, r) => s + (r.completion || 0), 0) / recent.length : 0.5;
  const perTag = new Map();
  for (const r of recent) {
    for (const t of r.tags) {
      const e = perTag.get(t) || { sum: 0, n: 0 };
      e.sum += (r.completion || 0) + (r.liked ? 0.5 : 0) - (r.skipped ? 0.5 : 0);
      e.n += 1;
      perTag.set(t, e);
    }
  }
  const adjustments = [...perTag.entries()]
    .filter(([, e]) => e.n >= 2)
    .map(([tag, e]) => ({ tag, delta: Math.max(-1, Math.min(1, (e.sum / e.n - avg) * 1.5)), reason: "watch-time trend" }))
    .filter((a) => Math.abs(a.delta) > 0.1)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 10);
  const rising = adjustments.filter((a) => a.delta > 0).map((a) => a.tag);
  const top = [...interests].sort((a, b) => b.weight - a.weight).slice(0, 8).map((i) => i.tag);
  // Exploration: pick taxonomy neighbours not yet in the profile.
  const have = new Set(interests.map((i) => i.tag));
  const newInterests = Object.keys(TAXONOMY)
    .filter((t) => !have.has(t))
    .sort(() => Math.random() - 0.5)
    .slice(0, 2)
    .map((tag) => ({ tag, weight: 0.25, why: "exploration" }));
  const insight = rising.length
    ? `You keep watching ${rising[0].replace(/-/g, " ")} to the end. More of that coming.`
    : "Your feed is settling in. Keep scrolling and it keeps tuning.";
  return {
    summary: summary || "",
    adjustments,
    newInterests,
    queries: queriesFromTags([...new Set([...rising, ...top])]),
    insight,
    mode: "heuristic",
  };
}
