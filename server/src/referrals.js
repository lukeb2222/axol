// The referral program.
//
// Every member has ten invite links, each good for one new member. When the first person joins
// through one of them (signs up and finishes setup), the member earns one free ad: a YouTube
// Short of their choice, shown to axol viewers as a labelled, skippable "Sponsored" clip for a
// week. The owner reviews every ad before it runs.
import { randomBytes } from "node:crypto";
import { db, q, uid, now, transaction } from "./db.js";
import { PLAYABLE } from "./ranker.js";
import { publicVideo } from "./videoView.js";
import { youtube } from "./sources/youtube.js";
import { upsertVideos, tagPending } from "./ingest.js";
import { SPONSORED, subscribeUrl } from "./promotions.js";
import { track } from "./activity.js";

export const INVITES_PER_MEMBER = 10;
export const JOINS_PER_AD = 1;   // people who must join through a member's links to earn the ad
export const ADS_PER_MEMBER = 1;
export const AD_TERM_DAYS = 7;
const DAY = 86400e3;
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no look-alike characters

export class AdError extends Error {}

function newCode() {
  return Array.from(randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join("");
}

/** Make sure the member has their ten links. */
export function ensureInvites(userId) {
  const have = q.get("SELECT COUNT(*) AS n FROM invites WHERE user_id = ?", userId).n;
  for (let i = have; i < INVITES_PER_MEMBER; i++) {
    q.run("INSERT OR IGNORE INTO invites (code, user_id, created_at) VALUES (?, ?, ?)", newCode(), userId, now() + i);
  }
}

/** Called at sign-up. Marks the link used and records who invited the new member. Returns the inviter's id, or null. */
export function redeemInvite(code, newUserId) {
  code = String(code || "").trim().toLowerCase().slice(0, 32);
  if (!code) return null;
  const inv = q.get("SELECT * FROM invites WHERE code = ?", code);
  if (!inv || inv.used_by || inv.user_id === newUserId) return null;
  const done = q.run("UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL", newUserId, now(), code);
  if (!done.changes) return null;
  q.run("UPDATE users SET referred_by = ? WHERE id = ?", inv.user_id, newUserId);
  track(inv.user_id, "invite_used", { code });
  return inv.user_id;
}

function adView(a, at = now()) {
  const running = a.status === "approved" && a.starts_at <= at && a.ends_at > at;
  const state = a.status === "approved" ? (running ? "running" : "finished") : a.status; // pending | running | finished | rejected | ended
  return {
    id: a.id, state, url: a.url, title: a.title || "", creator: (a.creator || "").trim(), thumbnail: a.thumbnail || "",
    note: a.note, submittedAt: a.created_at, startsAt: a.starts_at, endsAt: a.ends_at,
    ...(a.starts_at ? adStats(a) : { shown: 0, viewers: 0, played: 0, finished: 0, clicks: 0 }),
  };
}

export function adStats(a) {
  const s = q.get(`SELECT COUNT(*) AS shown, COUNT(DISTINCT user_id) AS viewers, SUM(CASE WHEN watched_ms > 0 THEN 1 ELSE 0 END) AS played,
                          SUM(CASE WHEN watched_ms >= 0.9 * MAX(duration_ms, 1) THEN 1 ELSE 0 END) AS finished
                   FROM impressions WHERE video_id = ? AND reason = ? AND served_at >= ?`, a.video_id, SPONSORED, a.starts_at || 0);
  const clicks = q.get(`SELECT COUNT(*) AS n FROM events e JOIN impressions i ON i.id = e.impression_id
                        WHERE e.type = 'cta' AND i.video_id = ? AND i.reason = ? AND e.created_at >= ?`, a.video_id, SPONSORED, a.starts_at || 0)?.n || 0;
  return { shown: s.shown, viewers: s.viewers, played: s.played || 0, finished: s.finished || 0, clicks };
}

const ADS_SQL = "SELECT a.*, v.title, v.creator, v.thumbnail FROM ads a JOIN videos v ON v.id = a.video_id";

/** Everything the member's invite screen shows. */
export function referralState(userId) {
  ensureInvites(userId);
  const invites = q.all(`SELECT i.code, i.used_at, u.display_name AS name, COALESCE(p.onboarded, 0) AS onboarded
                         FROM invites i LEFT JOIN users u ON u.id = i.used_by LEFT JOIN profiles p ON p.user_id = i.used_by
                         WHERE i.user_id = ? ORDER BY i.created_at, i.code`, userId);
  const joined = invites.filter((i) => i.used_at && i.onboarded).length;
  const ads = q.all(`${ADS_SQL} WHERE a.user_id = ? ORDER BY a.created_at DESC`, userId);
  const earned = joined >= JOINS_PER_AD ? ADS_PER_MEMBER : 0;
  const used = ads.filter((a) => a.status !== "rejected").length;
  return {
    invites: invites.map((i) => ({
      code: i.code,
      // "signed_up" = created an account but has not finished setup yet, so it does not count so far.
      status: !i.used_at ? "open" : i.onboarded ? "joined" : "signed_up",
      name: i.used_at ? String(i.name || "").trim().split(/\s+/)[0] : "",
      usedAt: i.used_at || null,
    })),
    joined, needed: JOINS_PER_AD, adAvailable: earned - used > 0, termDays: AD_TERM_DAYS,
    ads: ads.map((a) => adView(a)),
  };
}

/** Spend the earned ad on a YouTube Short. It waits for the owner's approval. */
export async function submitAd(userId, url) {
  const st = referralState(userId);
  if (!st.adAvailable) throw new AdError(st.joined >= JOINS_PER_AD ? "You have already used your free ad." : "Your free ad unlocks when one person joins through one of your links.");
  const ref = youtube.fromUrl(url);
  if (!ref) throw new AdError("Paste a YouTube Shorts link, like youtube.com/shorts/…");
  const meta = await youtube.lookup(ref.external_id);
  if (!meta?.title) throw new AdError("axol couldn't find that video on YouTube. Check the link and try again.");
  if (meta.playable === false) throw new AdError("That video can't play outside YouTube (it is private, age-restricted, or has embedding turned off).");
  if (meta.duration_ms > 3 * 60e3) throw new AdError("Ads are Shorts: choose a video up to 3 minutes long.");
  const fresh = upsertVideos([{ ...ref, title: meta.title, creator: meta.creator || "", thumbnail: meta.thumbnail || ref.thumbnail, duration_ms: meta.duration_ms || 0, description: meta.description || "", query: "" }]);
  await tagPending(fresh);
  const video = q.get("SELECT id, creator, tagged FROM videos WHERE source = 'youtube' AND external_id = ?", ref.external_id);
  if (!video || video.tagged === 2) throw new AdError("That video can't be played on axol. Try a different one.");
  const creator = (meta.creator || video.creator || "").trim();
  q.run("INSERT INTO ads (id, user_id, video_id, url, cta_label, cta_url, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
    uid(), userId, video.id, ref.url, creator ? `Subscribe to ${creator} on YouTube` : "Subscribe on YouTube", subscribeUrl(meta.channelUrl || ref.url), now());
}

/** The owner's decision on an ad: approve (runs for a week from now), reject (the member may submit another), or end. */
export function decideAd(adId, action, note = "") {
  const ad = q.get("SELECT * FROM ads WHERE id = ?", adId);
  if (!ad) throw new AdError("No such ad.");
  const t = now();
  if (action === "approve") {
    if (ad.status !== "pending") throw new AdError("Only an ad waiting for review can be approved.");
    q.run("UPDATE ads SET status = 'approved', note = '', decided_at = ?, starts_at = ?, ends_at = ? WHERE id = ?", t, t, t + AD_TERM_DAYS * DAY, adId);
  } else if (action === "reject") {
    if (ad.status !== "pending") throw new AdError("Only an ad waiting for review can be rejected.");
    q.run("UPDATE ads SET status = 'rejected', note = ?, decided_at = ? WHERE id = ?", String(note).trim().slice(0, 300), t, adId);
  } else if (action === "end") {
    if (ad.status !== "approved") throw new AdError("Only a running ad can be ended.");
    q.run("UPDATE ads SET status = 'ended', decided_at = ?, ends_at = MIN(ends_at, ?) WHERE id = ?", t, t, adId);
  } else throw new AdError("Unknown action.");
  track(ad.user_id, `ad_${action === "approve" ? "approved" : action === "reject" ? "rejected" : "ended"}`, { ad: adId });
  return adminAds().find((a) => a.id === adId);
}

/** Every ad with who submitted it, for the owner's review screen. */
export function adminAds() {
  return q.all(`SELECT a.*, v.title, v.creator, v.thumbnail, u.email, u.display_name FROM ads a JOIN videos v ON v.id = a.video_id JOIN users u ON u.id = a.user_id
                ORDER BY CASE a.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, a.created_at DESC`)
    .map((a) => ({ ...adView(a), member: { id: a.user_id, email: a.email, name: a.display_name } }));
}

/**
 * One sponsored clip for this viewer's next batch, or null. A viewer meets a given ad at most
 * once a day and never again after tapping "Not me" on it; among the ads that qualify, the one
 * shown least so far goes first, so every member's ad gets a fair share.
 */
export function sponsoredItem(userId, exclude = new Set(), at = now()) {
  const live = q.all(`SELECT a.id AS ad_id, a.cta_label, a.cta_url, a.starts_at, a.ends_at, v.* FROM ads a JOIN videos v ON v.id = a.video_id
                      WHERE a.status = 'approved' AND a.starts_at <= ? AND a.ends_at > ? AND v.tagged = 1 AND ${PLAYABLE}`, at, at)
    .filter((a) => !exclude.has(a.id))
    .filter((a) => !q.get("SELECT 1 FROM impressions WHERE user_id = ? AND video_id = ? AND (hidden = 1 OR served_at > ?) LIMIT 1", userId, a.id, at - DAY));
  if (!live.length) return null;
  const shown = (a) => q.get("SELECT COUNT(*) AS n FROM impressions WHERE video_id = ? AND reason = ? AND served_at >= ?", a.id, SPONSORED, a.starts_at).n;
  const pick = live.map((a) => ({ a, n: shown(a) })).sort((x, y) => x.n - y.n || x.a.starts_at - y.a.starts_at)[0].a;
  const id = uid();
  transaction(() => db.prepare("INSERT INTO impressions (id, user_id, video_id, served_at, duration_ms, reason, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, userId, pick.id, at, pick.duration_ms, SPONSORED, at));
  const item = { ...publicVideo(pick), topics: [] };
  return {
    impressionId: id, reason: SPONSORED, ...item,
    why: { kind: "sponsored", label: SPONSORED, topic: null, clipTopics: [],
      detail: "An axol member earned this spot by inviting a friend. It was not picked from your history, you can skip it, and it does not change your feed." },
    promo: { label: SPONSORED, until: pick.ends_at, mustWatch: false, cta: { label: pick.cta_label, url: pick.cta_url } },
  };
}
