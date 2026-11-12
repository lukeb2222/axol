// Explicit viewer preferences: more, less, mute, remove. Every action goes through the topic's
// canonical identity, so "motocross-big-air" and "big-air-motocross" are one control, and an
// action on either applies to the topic as a whole without losing what was learned under any name.
import { q, now, transaction } from "./db.js";
import { config } from "./config.js";
import { topicKey, isAbout } from "./topics.js";
import { normalizeTag } from "./ai/taxonomy.js";

const MAX = config.learning.maxWeight;
const ORIGIN_RANK = { onboarding: 4, search: 3, asked: 3, learned: 2, ai: 1 };
const clamp = (x) => Math.max(-MAX, Math.min(MAX, x));

/** Every interest row of this viewer that names the same topic as `tag`. */
export function equivalentRows(userId, tag) {
  const key = topicKey(tag);
  if (!key) return [];
  return q.all("SELECT * FROM interests WHERE user_id = ?", userId).filter((r) => topicKey(r.tag) === key);
}

/**
 * Fold duplicate rows for one topic into a single row and return it (or null if the viewer has
 * none). The surviving row keeps the strongest row's name, the combined weight and view counts,
 * and the most deliberate origin, so no preference is lost.
 */
export function consolidate(userId, tag) {
  const rows = equivalentRows(userId, tag);
  if (!rows.length) return null;
  if (rows.length === 1) return rows[0];
  const primary = rows.slice().sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))[0];
  const merged = {
    weight: clamp(rows.reduce((s, r) => s + r.weight, 0)),
    impressions: rows.reduce((s, r) => s + r.impressions, 0),
    positive: rows.reduce((s, r) => s + r.positive, 0),
    origin: rows.slice().sort((a, b) => (ORIGIN_RANK[b.origin] || 0) - (ORIGIN_RANK[a.origin] || 0))[0].origin,
  };
  transaction(() => {
    for (const r of rows) if (r.tag !== primary.tag) q.run("DELETE FROM interests WHERE user_id = ? AND tag = ?", userId, r.tag);
    q.run("UPDATE interests SET weight = ?, impressions = ?, positive = ?, origin = ?, updated_at = ? WHERE user_id = ? AND tag = ?",
      merged.weight, merged.impressions, merged.positive, merged.origin, now(), userId, primary.tag);
  });
  return { ...primary, ...merged };
}

function readAvoid(userId) {
  return JSON.parse(q.get("SELECT avoid_json FROM profiles WHERE user_id = ?", userId)?.avoid_json || "[]");
}
function writeAvoid(userId, list) {
  q.run("UPDATE profiles SET avoid_json = ? WHERE user_id = ?", JSON.stringify(list), userId);
}

/**
 * More of a topic. Existing behaviour of the profile's boost (+1), extended two ways: it works on
 * a topic the viewer has no row for yet (a More tap on a new subject), and it lifts a topic that
 * was previously turned down or muted back above zero.
 */
export function boostTopic(userId, rawTag, { create = false } = {}) {
  const tag = normalizeTag(rawTag);
  if (!tag) return null;
  const key = topicKey(tag);
  const avoid = readAvoid(userId);
  if (avoid.some((a) => topicKey(a) === key)) writeAvoid(userId, avoid.filter((a) => topicKey(a) !== key));
  const row = consolidate(userId, tag);
  if (row) {
    const weight = clamp(Math.max(row.weight, 0) + 1);
    q.run("UPDATE interests SET weight = ?, updated_at = ? WHERE user_id = ? AND tag = ?", weight, now(), userId, row.tag);
    return { tag: row.tag, weight, created: false };
  }
  if (!create) return null;
  q.run("INSERT INTO interests (user_id, tag, weight, impressions, positive, origin, updated_at) VALUES (?, ?, 1.5, 0, 0, 'asked', ?)", userId, tag, now());
  return { tag, weight: 1.5, created: true };
}

/**
 * Less of a topic: a strong, lasting down-weight. Deliberately not the same as mute. Mute removes
 * a topic from the feed entirely; "less" still lets the occasional one through.
 */
export function lessTopic(userId, rawTag) {
  const tag = normalizeTag(rawTag);
  if (!tag) return null;
  // Narrower interests about the same subject ("bmx-riding", "freestyle-bmx" under "bmx") would
  // otherwise keep pulling it back in. They are set to neutral, not deleted: what was learned
  // about them stays on record and they can rise again if the viewer watches them.
  const key = topicKey(tag);
  for (const r of q.all("SELECT tag, weight FROM interests WHERE user_id = ? AND weight > 0", userId)) {
    if (topicKey(r.tag) !== key && isAbout(r.tag, tag)) q.run("UPDATE interests SET weight = 0, updated_at = ? WHERE user_id = ? AND tag = ?", now(), userId, r.tag);
  }
  const row = consolidate(userId, tag);
  if (row) {
    const weight = clamp(Math.min(row.weight, 0) - 1.5);
    q.run("UPDATE interests SET weight = ?, updated_at = ? WHERE user_id = ? AND tag = ?", weight, now(), userId, row.tag);
    return { tag: row.tag, weight, created: false };
  }
  q.run("INSERT INTO interests (user_id, tag, weight, impressions, positive, origin, updated_at) VALUES (?, ?, -1.5, 0, 0, 'asked', ?)", userId, tag, now());
  return { tag, weight: -1.5, created: true };
}

/** Mute: never show the topic. Unchanged in meaning; now covers every name of the topic. */
export function muteTopic(userId, rawTag) {
  const tag = normalizeTag(rawTag) || String(rawTag || "");
  if (!tag) return;
  const avoid = readAvoid(userId);
  const key = topicKey(tag);
  if (!avoid.some((a) => topicKey(a) === key)) writeAvoid(userId, [...avoid, tag]);
  for (const r of equivalentRows(userId, tag)) q.run("DELETE FROM interests WHERE user_id = ? AND tag = ?", userId, r.tag);
}

/** Remove a topic from the profile without muting it. */
export function removeTopic(userId, rawTag) {
  const rows = equivalentRows(userId, rawTag);
  for (const r of rows) q.run("DELETE FROM interests WHERE user_id = ? AND tag = ?", userId, r.tag);
  if (!rows.length) q.run("DELETE FROM interests WHERE user_id = ? AND tag = ?", userId, String(rawTag || ""));
}

/** Interests as the profile screen shows them: one entry per topic, however many names it has. */
export function groupedInterests(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = topicKey(r.tag) || r.tag;
    const g = groups.get(key);
    if (!g) { groups.set(key, { ...r, aliases: [], top: Math.abs(r.weight) }); continue; }
    g.aliases.push(Math.abs(r.weight) > g.top ? g.tag : r.tag);
    if (Math.abs(r.weight) > g.top) { g.top = Math.abs(r.weight); g.tag = r.tag; }
    g.weight = clamp(g.weight + r.weight);
    g.impressions += r.impressions;
    g.positive += r.positive;
    if ((ORIGIN_RANK[r.origin] || 0) > (ORIGIN_RANK[g.origin] || 0)) g.origin = r.origin;
    g.updated_at = Math.max(g.updated_at || 0, r.updated_at || 0);
  }
  return [...groups.values()].map(({ top, ...g }) => g).sort((a, b) => b.weight - a.weight);
}
