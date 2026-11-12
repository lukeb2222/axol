// The shape of a clip as the web app receives it.
import { config } from "./config.js";
import { safeTags } from "./learner.js";
import { steerableTopics } from "./topics.js";

export function publicVideo(v) {
  return {
    id: v.id, source: v.source, externalId: v.external_id, embedKind: v.embed_kind, url: v.url,
    title: v.title, creator: v.creator, thumbnail: v.thumbnail, durationMs: v.duration_ms,
    tags: safeTags(v.tags_json).map((t) => t.tag), query: v.query,
    // The subjects this clip is actually about: what "More …" / "Less …" can be offered for.
    topics: steerableTopics(safeTags(v.tags_json)),
    // Present when axol holds the file itself: the app then uses its own player.
    videoUrl: v.media_file ? `${config.publicOrigin}/api/media/${v.id}.mp4` : null,
  };
}
