// Search: rank the catalog against what the whole query means, and say honestly what was found.
//
// The rule that matters: a result must match the query's meaning in ITS OWN metadata (tags, the
// caption/title, the description). One word of a two-word query is not a match, a substring is
// not a word ("ski" is not in "skills"), and the search that originally fetched a clip is only
// weak evidence about the clip itself. The same rule applies to clips that were already in the
// catalog and clips fetched a moment ago.
import { db, q, uid, now, transaction } from "./db.js";
import { config } from "./config.js";
import { safeTags } from "./learner.js";
import { loadUserModel, scoreVideo, isAvoided, PLAYABLE } from "./ranker.js";
import { stemWord, topicKey } from "./topics.js";
import { normalizeTag } from "./ai/taxonomy.js";
import { publicVideo } from "./videoView.js";
import { discoverTopic, topicStatus, saveQueries } from "./ingest.js";

const QUERY_NOISE = new Set(["short", "video", "clip", "reel", "tiktok", "youtube", "instagram", "the", "and", "of", "for", "to", "in", "a", "an", "on", "with", "how", "best"]);
const MAX_IDS = 150;

/** The query as the ranker sees it: its meaningful words, stemmed, plus the phrase as a whole. */
export function parseQuery(raw) {
  const words = String(raw || "").toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/).filter((w) => w.length > 1);
  const terms = [];
  for (const w of words) {
    const stem = stemWord(w);
    if (QUERY_NOISE.has(stem) || QUERY_NOISE.has(w)) continue;
    if (!terms.some((t) => t.stem === stem)) terms.push({ word: w, stem });
  }
  // A query made only of filler ("best videos") still searches for its words.
  if (!terms.length) for (const w of words.slice(0, 3)) terms.push({ word: w, stem: stemWord(w) });
  return { raw: String(raw || "").trim(), terms: terms.slice(0, 6), phraseKey: topicKey(words.join("-")), compound: words.join("") };
}

const tokenize = (text) => String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);

/** One clip's searchable text, split by where the words came from. */
function documentOf(video) {
  const tags = safeTags(video.tags_json);
  const tagStems = new Map(); // stem -> best relevance of a tag containing it
  for (const t of tags) for (const part of tokenize(t.tag)) {
    const s = stemWord(part);
    tagStems.set(s, Math.max(tagStems.get(s) || 0, t.relevance ?? 0.7));
  }
  const titleTokens = tokenize(video.title), descTokens = tokenize(video.description);
  return {
    tags, tagStems,
    tagKeys: new Set(tags.map((t) => topicKey(t.tag))),
    title: new Set(titleTokens.map(stemWord)), titleRaw: new Set(titleTokens), titleStems: titleTokens.map(stemWord),
    desc: new Set(descTokens.map(stemWord)), descRaw: new Set(descTokens),
    provenance: new Set(tokenize(video.query).map(stemWord)),
  };
}

// How much a word counts depending on where it was found. A word in the clip's own tags or
// caption is real evidence; the search that fetched it (provenance) is a hint at best.
const EVIDENCE = { tagBase: 0.6, tagRelevance: 0.4, title: 0.8, description: 0.55, provenance: 0.3 };
const OWN_METADATA = 0.5; // evidence at or above this came from the clip itself

function termEvidence(doc, stem) {
  let e = 0;
  if (doc.tagStems.has(stem)) e = Math.max(e, EVIDENCE.tagBase + EVIDENCE.tagRelevance * doc.tagStems.get(stem));
  if (doc.title.has(stem)) e = Math.max(e, EVIDENCE.title);
  if (doc.desc.has(stem)) e = Math.max(e, EVIDENCE.description);
  if (!e && doc.provenance.has(stem)) e = EVIDENCE.provenance;
  return e;
}

/**
 * Rank `videos` against a query. Pure: no database, no clock (exported for tests).
 * Returns
 *   strong  — clips that match the whole query, best first. This is the result list.
 *   related — clips that match the query's most specific word but not all of it. Never mixed into
 *             the results; offered separately as a way to broaden.
 */
export function rankSearch(videos, raw, model = null) {
  const query = parseQuery(raw);
  if (!query.terms.length) return { query, strong: [], related: [] };
  const docs = videos.map((v) => ({ v, doc: documentOf(v) }));

  // How specific is each query word within this catalog? A word found in many clips ("freestyle")
  // says less than one found in few ("skiing"); a word found nowhere is the most specific of all.
  const N = Math.max(1, docs.length);
  const idf = query.terms.map((t) => {
    let df = 0;
    for (const { doc } of docs) if (doc.tagStems.has(t.stem) || doc.title.has(t.stem) || doc.desc.has(t.stem)) df++;
    return Math.log(1 + N / (1 + df));
  });
  const idfSum = idf.reduce((a, b) => a + b, 0) || 1;
  const allowedMissing = query.terms.length <= 2 ? 0 : 0.2; // long queries may miss one minor word

  const strong = [], related = [];
  for (const { v, doc } of docs) {
    if (model && isAvoided(doc.tags, model)) continue;
    // The whole phrase as one tag ("freestyle-skiing") or one hashtag ("#freestyleskiing").
    const phrase = doc.tagKeys.has(query.phraseKey) || (query.terms.length > 1 && (doc.titleRaw.has(query.compound) || doc.descRaw.has(query.compound)));
    let quality = 0, matchedShare = 0, missingShare = 0, topMatched = false;
    const matched = [], missing = [];
    const topIdx = idf.indexOf(Math.max(...idf));
    query.terms.forEach((t, i) => {
      const e = phrase ? Math.max(termEvidence(doc, t.stem), 0.9) : termEvidence(doc, t.stem);
      quality += idf[i] * e;
      if (e >= OWN_METADATA) { matchedShare += idf[i] / idfSum; matched.push(t.word); if (i === topIdx) topMatched = true; }
      else { missingShare += idf[i] / idfSum; missing.push(t.word); }
    });
    if (!matched.length) continue;
    quality /= idfSum;
    // Words next to each other in the caption, in order, read as the phrase.
    let adjacent = false;
    if (query.terms.length > 1) {
      const seq = query.terms.map((t) => t.stem);
      for (let i = 0; i + seq.length <= doc.titleStems.length && !adjacent; i++) adjacent = seq.every((s, k) => doc.titleStems[i + k] === s);
    }
    const fit = model ? scoreVideo(v, model, { rand: () => 0.5 }) : null;
    const score = quality + (phrase ? 0.5 : 0) + (adjacent ? 0.2 : 0) + 0.05 * Math.max(-2, Math.min(2, fit?.match || 0));
    const entry = { video: v, score, matched, missing };
    if (missingShare <= allowedMissing + 1e-9) strong.push(entry);
    else if (topMatched && matchedShare > 0.5) related.push(entry);
  }

  const order = (list) => {
    list.sort((a, b) => b.score - a.score || (a.video.id < b.video.id ? -1 : 1));
    // Light creator diversity so one account does not fill the grid; never drops anything.
    const seen = new Map();
    for (const e of list) { const k = e.video.creator || e.video.id; const n = seen.get(k) || 0; seen.set(k, n + 1); e.score -= n * 0.15; }
    return list.sort((a, b) => b.score - a.score || (a.video.id < b.video.id ? -1 : 1));
  };
  return { query, strong: order(strong), related: order(related) };
}

/* ------------------------------ database-backed service ------------------------------ */

function catalog() {
  return q.all(`SELECT v.* FROM videos v WHERE v.tagged = 1 AND ${PLAYABLE} ORDER BY v.created_at DESC LIMIT 4000`);
}

/** Turn catalog rows into feed-style items, each with its own impression, in the order given. */
function serve(userId, raw, videos) {
  const ins = db.prepare("INSERT INTO impressions (id, user_id, video_id, served_at, duration_ms, reason, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const label = `You searched ${raw}`;
  return transaction(() => videos.map((v) => {
    const id = uid();
    ins.run(id, userId, v.id, now(), v.duration_ms, label, now());
    const item = publicVideo(v);
    return { impressionId: id, reason: label, ...item,
      why: { kind: "search", label, topic: null, clipTopics: item.topics.map((t) => t.label), detail: `It matches your search for “${raw}”.` } };
  }));
}

/** What the viewer can do to widen a search right now, and what is standing in the way. */
export function discoveryOptions(raw) {
  const st = topicStatus(raw);
  return {
    available: st.available,   // platforms a fresh search could run on now
    pending: st.pending,       // fresh searches still running
    paused: st.paused,         // platforms whose daily budget is spent
    upToDate: st.fresh,        // platforms already searched for this recently
  };
}

/**
 * Search the catalog. Fetches nothing: fresh discovery is a separate, explicit action.
 * `scope` is "strong" (the results) or "related" (the optional broader list).
 * The response's `ids` is the complete ordered list; `total` is its length; `items` is its first
 * page. Further pages come from `hydrate` with ids taken from that same list, so the count, the
 * grid and the swipeable player can never disagree.
 */
export function searchCatalog(userId, raw, { scope = "strong", n = 18, remember = true } = {}) {
  const model = loadUserModel(userId);
  const ranked = rankSearch(catalog(), raw, model);
  const list = scope === "related" ? ranked.related : ranked.strong;
  const ids = list.slice(0, MAX_IDS).map((e) => e.video.id);

  // A search is a statement of interest: remember it, and let the feed's own discovery look for it.
  if (remember && scope === "strong" && ranked.query.terms.length) {
    const tag = normalizeTag(ranked.query.terms.map((t) => t.word).join(" "));
    const key = topicKey(tag);
    const row = q.all("SELECT tag, weight FROM interests WHERE user_id = ?", userId).find((r) => topicKey(r.tag) === key);
    if (row) q.run("UPDATE interests SET weight = MIN(?, MAX(weight, 0) + 0.3), updated_at = ? WHERE user_id = ? AND tag = ?", config.learning.maxWeight, now(), userId, row.tag);
    else if (tag) q.run("INSERT INTO interests (user_id, tag, weight, impressions, positive, origin, updated_at) VALUES (?, ?, 0.8, 0, 0, 'search', ?)", userId, tag, now());
    const text = ranked.query.raw.toLowerCase();
    saveQueries(userId, { youtube: [`${text} shorts`], tiktok: [text], instagram: [text] });
  }

  const head = list.slice(0, Math.min(n, MAX_IDS)).map((e) => e.video);
  return {
    q: ranked.query.raw,
    scope,
    terms: ranked.query.terms.map((t) => t.word),
    total: ids.length,
    ids,
    items: serve(userId, ranked.query.raw, head),
    relatedTotal: Math.min(MAX_IDS, ranked.related.length),
    // For the related list: which query words each of these clips is missing.
    relatedMissing: scope === "related" ? [...new Set(ranked.related.flatMap((e) => e.missing))] : [...new Set(ranked.related.slice(0, 20).flatMap((e) => e.missing))],
    discovery: discoveryOptions(ranked.query.raw),
  };
}

/** Load specific results by id, in the order asked for. Only ids that still exist and can play. */
export function hydrate(userId, raw, ids) {
  const wanted = [...new Set((ids || []).map(String))].slice(0, 30);
  if (!wanted.length) return [];
  const rows = q.all(`SELECT v.* FROM videos v WHERE v.tagged = 1 AND ${PLAYABLE} AND v.id IN (${wanted.map(() => "?").join(",")})`, ...wanted);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return serve(userId, String(raw || "").trim(), wanted.map((id) => byId.get(id)).filter(Boolean));
}

/**
 * The optional "look for fresh clips" action. Runs a live search on every platform that has
 * budget and has not already searched this topic today. When a platform's daily budget is spent
 * it is reported as paused and nothing is attempted on it. Whatever comes back is only shown if
 * it passes the same ranking as everything else.
 */
export async function broaden(userId, raw, { waitMs = 6000 } = {}) {
  const before = discoveryOptions(raw);
  if (!before.available.length) return { started: [], ...before };
  await discoverTopic(raw, { waitMs }).catch(() => null);
  return { started: before.available, ...discoveryOptions(raw) };
}
