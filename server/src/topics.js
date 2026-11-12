// One shared vocabulary for "what is this clip about?".
//
// Search, ranking, explanations, learning and steering all have to answer the same two questions:
//   1. Are these two topic names the same topic?   ("motocross-big-air" vs "big-air-motocross")
//   2. Do these two topics genuinely overlap?      ("specialty-coffee" vs "coffee-making": yes;
//                                                   "stunt-motocross-rider-pov" vs "coffee-pov": no)
// Answering them in one place keeps those features consistent with each other.

const STOP = new Set(["and", "the", "of", "for", "with", "to", "in", "a", "an", "on", "at", "by", "my", "your", "is", "it"]);

/**
 * Words that describe a clip's FORMAT, VIBE or QUALITY rather than its subject. Two clips sharing
 * only these are not about the same thing: a coffee POV and a motocross POV share a camera angle,
 * a "bmx freestyle" and a "rap freestyle" share a modifier. Stored in stemmed form.
 */
const GENERIC_WORDS = [
  "pov", "tutorial", "tip", "trick", "hack", "guide", "howto", "how", "lesson", "explained", "explainer", "beginner", "advanced", "pro", "easy",
  "highlight", "compilation", "moment", "clip", "video", "short", "reel", "edit", "montage", "recap", "review", "reaction", "listicle", "list", "tier",
  "viral", "fyp", "foryou", "foryoupage", "trending", "trend", "challenge", "hype", "epic", "insane", "crazy", "amazing", "cool", "best", "top", "new",
  "funny", "comedy", "humor", "meme", "satisfying", "asmr", "relaxing", "aesthetic", "vibe", "mood", "motivation", "motivational", "inspiration", "inspirational",
  "vlog", "storytelling", "storytime", "story", "day", "daily", "life", "lifestyle", "routine", "culture", "community", "call", "action",
  "freestyle", "skill", "progression", "training", "drill", "practice", "workout", "fail", "win", "girl", "boy", "guy", "kid",
  "rider", "player", "athlete", "sport", "fan", "lover", "creator", "content",
];

/** Light stemmer: enough to make ski / skis / skiing / skier and trick / tricks meet. */
export function stemWord(raw) {
  let w = String(raw || "").toLowerCase();
  if (w.length <= 3) return w;
  if (w.endsWith("ies") && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) w = w.slice(0, -1);
  const strip = (suffix) => {
    if (!w.endsWith(suffix) || w.length - suffix.length < 3) return false;
    w = w.slice(0, -suffix.length);
    if (w.length > 3 && w[w.length - 1] === w[w.length - 2] && !/[aeiou]/.test(w[w.length - 1]) && !/(ll|ss|ff)$/.test(w)) w = w.slice(0, -1); // running -> run
    return true;
  };
  if (w.length >= 5) strip("ing") || strip("er");
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1); // ride / riding, make / making
  return w;
}

const GENERIC = new Set(GENERIC_WORDS.map(stemWord));
export const isGenericWord = (stem) => GENERIC.has(stem);

/** All meaningful words of a tag or phrase, stemmed, in order, de-duplicated. */
export function topicWords(tag) {
  const out = [];
  for (const part of String(tag || "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (part.length < 2 || STOP.has(part)) continue;
    const s = stemWord(part);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/** The subject words only: what the clip is about, without format and vibe words. */
export const contentWords = (tag) => topicWords(tag).filter((w) => !GENERIC.has(w));

/** A tag made only of format/vibe words ("pov", "satisfying", "comedy-highlight"). */
export const isFormatTag = (tag) => contentWords(tag).length === 0;

/**
 * Canonical identity of a topic name. Word order, plurals and filler words do not change it, so
 * "motocross-big-air", "big-air-motocross" and "Big Air Motocross" are one topic.
 */
export function topicKey(tag) {
  return [...topicWords(tag)].sort().join("-");
}

/**
 * How two topics relate.
 *   same    — identical after canonicalization
 *   related — they share at least one SUBJECT word; `shared` is that common ground and `strength`
 *             is 1 when one topic contains the other ("coffee" within "specialty coffee")
 *   null    — nothing in common beyond format words
 */
export function relate(a, b) {
  const ka = topicKey(a), kb = topicKey(b);
  if (!ka || !kb) return null;
  if (ka === kb) return { kind: "same", shared: contentWords(a).length ? contentWords(a) : topicWords(a), strength: 1 };
  const ca = contentWords(a), cb = contentWords(b);
  if (!ca.length || !cb.length) return null;
  const shared = ca.filter((w) => cb.includes(w));
  if (!shared.length) return null;
  return { kind: "related", shared, strength: shared.length / Math.min(ca.length, cb.length) };
}

/**
 * Is `clipTag` an instance of `topic`? True when the clip tag covers every subject word of the
 * topic: "bmx-freestyle" and "bmx-street" are both about "bmx". Used when a viewer asks for more
 * or less of something.
 */
export function isAbout(clipTag, topic) {
  if (topicKey(clipTag) === topicKey(topic)) return true;
  const want = contentWords(topic);
  if (!want.length) return false; // a pure format topic only matches itself
  const have = contentWords(clipTag);
  return want.every((w) => have.includes(w));
}

const ACRONYMS = new Set(["bmx", "ai", "nba", "nfl", "mlb", "nhl", "mma", "ufc", "diy", "asmr", "pov", "f1", "edm", "tv", "ui", "ux", "pc", "vr", "nyc", "usa", "uk"]);
/** Human label for a tag: "ski-tricks" -> "ski tricks", "bmx" -> "BMX". */
export function prettyTopic(tag) {
  return String(tag || "").split("-").filter(Boolean).map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w)).join(" ");
}

/** Readable form of shared stems, taken from the original words of `tag` where possible. */
export function prettyShared(shared, ...tags) {
  const originals = new Map();
  for (const tag of tags) for (const part of String(tag || "").toLowerCase().split(/[^a-z0-9]+/)) {
    const s = stemWord(part);
    if (part && !originals.has(s)) originals.set(s, part);
  }
  return prettyTopic(shared.map((s) => originals.get(s) || s).join("-"));
}

/**
 * The topics a viewer can steer by for one clip: its strongest subject tags, one per distinct
 * subject, shortest name first ("bmx" rather than both "bmx" and "bmx-freestyle").
 */
export function steerableTopics(tags, { max = 3, minRelevance = 0.5 } = {}) {
  const picked = [];
  const sorted = [...tags].filter((t) => t && t.tag && (t.relevance ?? 1) >= minRelevance && !isFormatTag(t.tag))
    .sort((a, b) => (b.relevance ?? 1) - (a.relevance ?? 1) || contentWords(a.tag).length - contentWords(b.tag).length);
  for (const t of sorted) {
    const subject = contentWords(t.tag).slice().sort().join("-");
    const clash = picked.findIndex((p) => p.subject === subject || isAbout(t.tag, p.tag) || isAbout(p.tag, t.tag));
    if (clash >= 0) {
      // Keep the broader, shorter name for the same subject.
      if (contentWords(t.tag).length < contentWords(picked[clash].tag).length) picked[clash] = { tag: t.tag, subject };
      continue;
    }
    picked.push({ tag: t.tag, subject });
    if (picked.length >= max) break;
  }
  return picked.map((p) => ({ tag: p.tag, label: prettyTopic(p.tag) }));
}
