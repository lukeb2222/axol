import { z } from "zod";
import { structured } from "./claude.js";
import { extractTags, normalizeTag } from "./taxonomy.js";

const TagSchema = z.object({
  items: z.array(z.object({
    id: z.string(),
    tags: z.array(z.object({
      tag: z.string().describe("kebab-case topic"),
      relevance: z.number().min(0).max(1),
    })).min(1).max(8),
  })),
});

const SYSTEM = `You label short-form videos for a personalized feed. For each item, produce 3-8 kebab-case topic tags with relevance 0-1.
Tags should capture topic, format (tutorial, pov, highlight, comedy, satisfying, review), and vibe where obvious. Prefer tags that would be reused across many videos. Use the discovery query as a strong hint when metadata is thin. Echo each id exactly.`;

/** @param {Array<{id,title,description,creator,query,source}>} videos → Map id -> [{tag,relevance}] */
export async function tagVideos(videos) {
  const out = new Map();
  if (!videos.length) return out;
  const user = videos
    .map((v) => `id=${v.id}\nsource=${v.source}\nquery=${v.query}\ntitle=${v.title}\ncreator=${v.creator}\ndescription=${(v.description || "").slice(0, 300)}`)
    .join("\n---\n");
  const ai = await structured({ schema: TagSchema, system: SYSTEM, user, effort: "low", maxTokens: 12000 });
  if (ai) {
    for (const it of ai.items) {
      const tags = dedupe(it.tags.map((t) => ({ tag: normalizeTag(t.tag), relevance: t.relevance })));
      if (tags.length) out.set(it.id, tags);
    }
  }
  for (const v of videos) if (!out.has(v.id)) out.set(v.id, heuristicTags(v));
  return out;
}

export function heuristicTags(v) {
  const hits = extractTags(`${v.title} ${v.description} ${v.query} ${v.creator}`);
  const tags = [...hits.entries()].map(([tag, n]) => ({ tag, relevance: Math.min(1, 0.5 + 0.2 * n) }));
  const qTag = normalizeTag(String(v.query || "").replace(/\bshorts?\b/g, ""));
  if (qTag && !hits.has(qTag)) tags.push({ tag: qTag, relevance: 0.9 });
  if (!tags.length) tags.push({ tag: v.source, relevance: 0.3 });
  return dedupe(tags).slice(0, 8);
}

function dedupe(tags) {
  const m = new Map();
  for (const t of tags) if (t.tag && (!m.has(t.tag) || m.get(t.tag) < t.relevance)) m.set(t.tag, t.relevance);
  return [...m.entries()].map(([tag, relevance]) => ({ tag, relevance })).sort((a, b) => b.relevance - a.relevance);
}
