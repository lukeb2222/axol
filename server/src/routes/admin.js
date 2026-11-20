// The owner's data view: who is using axol, what they typed and did, how the product is doing,
// and what looks worth fixing. Everything here is behind sign-in plus the owner flag.
// Passwords and session tokens are never returned or exported.
import { Router } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { q, now } from "../db.js";
import { config } from "../config.js";
import { requireAdmin } from "../auth.js";
import { safeTags } from "../learner.js";
import { track } from "../activity.js";
import { adminAds, decideAd, AdError } from "../referrals.js";
import { aiStatus } from "../ai/claude.js";

export const adminRouter = Router();
const DAY = 86400e3;
const json = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const pct = (x) => (x == null ? null : Math.round(x * 100));
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

/* ----------------------------------- owner key ---------------------------------- */

const attempts = new Map(); // userId -> timestamps of recent wrong keys
adminRouter.post("/claim", (req, res) => {
  if (req.user.is_admin) return res.json({ ok: true });
  if (!config.adminKey) return res.status(503).json({ error: "owner access isn't set up on this server yet" });
  const t = now(), recent = (attempts.get(req.user.id) || []).filter((x) => t - x < 3600e3);
  if (recent.length >= 5) return res.status(429).json({ error: "too many tries; wait an hour" });
  const digest = (s) => createHash("sha256").update(String(s)).digest();
  if (!timingSafeEqual(digest(req.body?.key || ""), digest(config.adminKey))) {
    attempts.set(req.user.id, [...recent, t]);
    return res.status(403).json({ error: "that isn't the owner key" });
  }
  q.run("UPDATE users SET is_admin = 1 WHERE id = ?", req.user.id);
  track(req.user.id, "owner_access", {});
  res.json({ ok: true });
});

adminRouter.use(requireAdmin);

/* ----------------------------------- overview ----------------------------------- */

adminRouter.get("/overview", (req, res) => {
  const t = now();
  const tz = Math.max(-840, Math.min(840, Number(req.query.tz) || 0)) * 60e3;
  const day = (ms) => new Date(ms + tz).toISOString().slice(0, 10);
  const one = (sql, ...p) => q.get(sql, ...p)?.n || 0;
  const activeSince = (ms) => one("SELECT COUNT(DISTINCT user_id) AS n FROM impressions WHERE watched_ms > 0 AND served_at > ?", t - ms);

  // Fourteen days, oldest first.
  const days = Array.from({ length: 14 }, (_, i) => day(t - (13 - i) * DAY));
  const byDay = Object.fromEntries(days.map((d) => [d, { date: d, label: new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }), newUsers: 0, activeUsers: 0, clips: 0, minutes: 0 }]));
  for (const r of q.all(`SELECT strftime('%Y-%m-%d', (served_at + ?) / 1000, 'unixepoch') AS d, COUNT(DISTINCT user_id) AS users, COUNT(*) AS clips, SUM(watched_ms) AS ms
                         FROM impressions WHERE watched_ms > 0 AND served_at > ? GROUP BY d`, tz, t - 15 * DAY)) {
    if (byDay[r.d]) Object.assign(byDay[r.d], { activeUsers: r.users, clips: r.clips, minutes: Math.round(r.ms / 60000) });
  }
  for (const r of q.all("SELECT strftime('%Y-%m-%d', (created_at + ?) / 1000, 'unixepoch') AS d, COUNT(*) AS n FROM users WHERE created_at > ? GROUP BY d", tz, t - 15 * DAY)) {
    if (byDay[r.d]) byDay[r.d].newUsers = r.n;
  }

  // Funnel: how far each account got.
  const perUser = q.all(`SELECT user_id, COUNT(*) AS clips, COUNT(DISTINCT strftime('%Y-%m-%d', (served_at + ?) / 1000, 'unixepoch')) AS days
                         FROM impressions WHERE watched_ms > 0 GROUP BY user_id`, tz);
  const users = one("SELECT COUNT(*) AS n FROM users");
  const funnel = [
    { step: "Signed up", n: users },
    { step: "Finished setup", n: one("SELECT COUNT(*) AS n FROM profiles WHERE onboarded = 1") },
    { step: "Watched a clip", n: perUser.length },
    { step: "Watched 10+ clips", n: perUser.filter((u) => u.clips >= 10).length },
    { step: "Came back another day", n: perUser.filter((u) => u.days >= 2).length },
  ];

  const w = q.get(`SELECT COUNT(*) AS clips, COALESCE(SUM(watched_ms), 0) AS ms, COALESCE(SUM(liked), 0) AS likes, COALESCE(SUM(hidden), 0) AS hidden,
                          COALESCE(SUM(skipped), 0) AS skipped, AVG(CASE WHEN duration_ms > 0 THEN MIN(1.0, watched_ms * 1.0 / duration_ms) END) AS completion
                   FROM impressions WHERE watched_ms > 0`);
  const sources = q.all(`SELECT v.source, COUNT(*) AS clips, AVG(CASE WHEN i.duration_ms > 0 THEN MIN(1.0, i.watched_ms * 1.0 / i.duration_ms) END) AS completion,
                                AVG(i.skipped) AS skip, AVG(i.liked) AS liked
                         FROM impressions i JOIN videos v ON v.id = i.video_id WHERE i.finalized = 1 AND i.served_at > ? GROUP BY v.source ORDER BY clips DESC`, t - 30 * DAY);
  const starts = {};
  for (const r of q.all("SELECT v.source, i.start_ms FROM impressions i JOIN videos v ON v.id = i.video_id WHERE i.start_ms > 0 AND i.served_at > ?", t - 7 * DAY)) (starts[r.source] ||= []).push(r.start_ms);
  const broken = Object.fromEntries(q.all(`SELECT v.source, COUNT(*) AS n FROM events e JOIN impressions i ON i.id = e.impression_id JOIN videos v ON v.id = i.video_id
                                           WHERE e.type = 'broken' AND e.created_at > ? GROUP BY v.source`, t - 7 * DAY).map((r) => [r.source, r.n]));

  // Topics: which subjects hold people and which get skipped (a clip's two strongest tags).
  const topics = new Map();
  for (const r of q.all(`SELECT v.tags_json, i.watched_ms, i.duration_ms, i.skipped, i.hidden, i.liked FROM impressions i JOIN videos v ON v.id = i.video_id
                         WHERE i.finalized = 1 AND i.served_at > ? ORDER BY i.served_at DESC LIMIT 8000`, t - 30 * DAY)) {
    for (const { tag } of safeTags(r.tags_json).slice(0, 2)) {
      const e = topics.get(tag) || { tag, shown: 0, skipped: 0, hidden: 0, liked: 0, comp: 0, compN: 0 };
      e.shown++; e.skipped += r.skipped; e.hidden += r.hidden; e.liked += r.liked;
      if (r.duration_ms > 0) { e.comp += Math.min(1, r.watched_ms / r.duration_ms); e.compN++; }
      topics.set(tag, e);
    }
  }
  const topicRows = [...topics.values()].filter((e) => e.shown >= 5).map((e) => ({ tag: e.tag, shown: e.shown, skipRate: pct(e.skipped / e.shown), completion: e.compN ? pct(e.comp / e.compN) : null, notMe: e.hidden, likes: e.liked }));

  // Searches (from the activity log).
  const searches = new Map();
  for (const r of q.all("SELECT user_id, data_json, created_at FROM activity WHERE kind = 'search' AND created_at > ? ORDER BY id DESC LIMIT 5000", t - 30 * DAY)) {
    const d = json(r.data_json, {}), key = String(d.q || "").trim().toLowerCase();
    if (!key) continue;
    const e = searches.get(key) || { q: key, times: 0, people: new Set(), results: d.results ?? 0, last: r.created_at };
    e.times++; e.people.add(r.user_id); searches.set(key, e);
  }
  const searchRows = [...searches.values()].map((e) => ({ q: e.q, times: e.times, people: e.people.size, results: e.results, last: e.last }));

  const muted = new Map();
  for (const r of q.all("SELECT avoid_json FROM profiles WHERE avoid_json != '[]'")) for (const tag of json(r.avoid_json, [])) muted.set(tag, (muted.get(tag) || 0) + 1);
  const less = new Map();
  for (const r of q.all("SELECT data_json FROM activity WHERE kind = 'steer' AND created_at > ?", t - 30 * DAY)) { const d = json(r.data_json, {}); if (d.direction === "less" && d.tag) less.set(d.tag, (less.get(d.tag) || 0) + 1); }
  const top = (m, n = 10) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([tag, count]) => ({ tag, count }));

  res.json({
    generatedAt: t,
    totals: {
      users, newThisWeek: one("SELECT COUNT(*) AS n FROM users WHERE created_at > ?", t - 7 * DAY),
      activeToday: activeSince(DAY), activeWeek: activeSince(7 * DAY), activeMonth: activeSince(30 * DAY),
      clips: w.clips, hours: Math.round(w.ms / 360000) / 10, likes: w.likes, notMe: w.hidden,
      completion: pct(w.completion), skipRate: w.clips ? pct(w.skipped / w.clips) : null,
      feedback: one("SELECT COUNT(*) AS n FROM activity WHERE kind = 'feedback'"),
    },
    daily: days.map((d) => byDay[d]),
    funnel,
    sources: sources.map((s) => ({ source: s.source, clips: s.clips, completion: pct(s.completion), skipRate: pct(s.skip), likeRate: pct(s.liked), medianStartMs: median(starts[s.source] || []), broken: broken[s.source] || 0 })),
    topics: {
      best: [...topicRows].filter((r) => r.completion != null).sort((a, b) => b.completion - a.completion).slice(0, 8),
      skipped: [...topicRows].sort((a, b) => b.skipRate - a.skipRate).slice(0, 8),
    },
    asked: q.all("SELECT tag, COUNT(DISTINCT user_id) AS count FROM interests WHERE origin = 'onboarding' GROUP BY tag ORDER BY count DESC, tag LIMIT 15"),
    searches: {
      top: [...searchRows].sort((a, b) => b.times - a.times).slice(0, 12),
      empty: searchRows.filter((r) => r.results === 0).sort((a, b) => b.times - a.times).slice(0, 12),
    },
    muted: top(muted), less: top(less),
    notMeClips: q.all(`SELECT v.title, v.source, v.url, COUNT(*) AS count FROM impressions i JOIN videos v ON v.id = i.video_id WHERE i.hidden = 1 GROUP BY v.id ORDER BY count DESC LIMIT 8`),
    feedback: feedbackRows(8),
    referrals: {
      linksUsed: one("SELECT COUNT(*) AS n FROM invites WHERE used_by IS NOT NULL"),
      joined: one("SELECT COUNT(*) AS n FROM invites i JOIN profiles p ON p.user_id = i.used_by WHERE p.onboarded = 1"),
      members: one("SELECT COUNT(DISTINCT user_id) AS n FROM invites WHERE used_by IS NOT NULL"),
      adsPending: one("SELECT COUNT(*) AS n FROM ads WHERE status = 'pending'"),
      adsRunning: one("SELECT COUNT(*) AS n FROM ads WHERE status = 'approved' AND ends_at > ?", t),
    },
    system: { catalog: one("SELECT COUNT(*) AS n FROM videos WHERE tagged = 1"), aiSpendUsd: aiStatus().monthSpendUsd ?? null },
  });
});

function feedbackRows(limit) {
  return q.all(`SELECT a.id, a.user_id, a.data_json, a.created_at, u.email, u.display_name FROM activity a LEFT JOIN users u ON u.id = a.user_id
                WHERE a.kind = 'feedback' ORDER BY a.id DESC LIMIT ?`, limit)
    .map((r) => ({ id: r.id, userId: r.user_id, email: r.email, name: r.display_name, text: json(r.data_json, {}).text || "", at: r.created_at }));
}

/* ------------------------------------- users ------------------------------------ */

const USER_COLS = `u.id, u.email, u.display_name AS name, u.created_at, u.last_seen_at, u.is_admin, COALESCE(p.onboarded, 0) AS onboarded,
  (SELECT COUNT(*) FROM impressions i WHERE i.user_id = u.id AND i.watched_ms > 0) AS clips,
  (SELECT COALESCE(SUM(i.watched_ms), 0) FROM impressions i WHERE i.user_id = u.id) AS watched_ms,
  (SELECT COALESCE(SUM(i.liked), 0) FROM impressions i WHERE i.user_id = u.id) AS likes,
  (SELECT COUNT(*) FROM activity a WHERE a.user_id = u.id AND a.kind = 'search') AS searches,
  (SELECT COUNT(*) FROM invites v WHERE v.user_id = u.id AND v.used_by IS NOT NULL) AS invited,
  MAX(u.last_seen_at, COALESCE((SELECT MAX(i.served_at) FROM impressions i WHERE i.user_id = u.id), 0), u.created_at) AS last_active`;
const SORTS = { newest: "u.created_at DESC", active: "last_active DESC", watched: "watched_ms DESC" };

adminRouter.get("/users", (req, res) => {
  const term = `%${String(req.query.q || "").trim().slice(0, 80).replace(/[%_]/g, "")}%`;
  const limit = Math.min(100, Number(req.query.limit) || 50), offset = Math.max(0, Number(req.query.offset) || 0);
  const total = q.get("SELECT COUNT(*) AS n FROM users u WHERE u.email LIKE ? OR u.display_name LIKE ?", term, term).n;
  const users = q.all(`SELECT ${USER_COLS} FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.email LIKE ? OR u.display_name LIKE ?
                       ORDER BY ${SORTS[req.query.sort] || SORTS.newest} LIMIT ? OFFSET ?`, term, term, limit, offset);
  res.json({ total, users });
});

adminRouter.get("/users/:id", (req, res) => {
  const id = req.params.id;
  const user = q.get(`SELECT ${USER_COLS}, u.referred_by FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = ?`, id);
  if (!user) return res.status(404).json({ error: "no such user" });
  const p = q.get("SELECT raw_text, chips_json, summary, avoid_json FROM profiles WHERE user_id = ?", id) || {};
  const inviter = user.referred_by ? q.get("SELECT id, email, display_name AS name FROM users WHERE id = ?", user.referred_by) : null;
  res.json({
    user: { ...user, invitedBy: inviter },
    typed: { onboardingText: p.raw_text || "", onboardingPicks: json(p.chips_json, []), muted: json(p.avoid_json, []) },
    profileSummary: p.summary || "",
    interests: q.all("SELECT tag, weight, origin, impressions, positive FROM interests WHERE user_id = ? ORDER BY weight DESC LIMIT 40", id).map((i) => ({ ...i, weight: Math.round(i.weight * 100) / 100 })),
    activity: q.all("SELECT id, kind, data_json, created_at FROM activity WHERE user_id = ? ORDER BY id DESC LIMIT 200", id).map((a) => ({ id: a.id, kind: a.kind, data: json(a.data_json, {}), at: a.created_at })),
    watched: q.all(`SELECT i.served_at, i.watched_ms, i.duration_ms, i.liked, i.shared, i.hidden, i.skipped, i.replays, i.reason, v.title, v.source, v.url, v.creator
                    FROM impressions i JOIN videos v ON v.id = i.video_id WHERE i.user_id = ? AND (i.watched_ms > 0 OR i.finalized = 1) ORDER BY i.served_at DESC LIMIT 60`, id),
    invites: q.all(`SELECT i.code, i.used_at, u.email, u.display_name AS name FROM invites i LEFT JOIN users u ON u.id = i.used_by WHERE i.user_id = ? AND i.used_by IS NOT NULL ORDER BY i.used_at`, id),
  });
});

/* ------------------------------ activity and feedback ---------------------------- */

adminRouter.get("/activity", (req, res) => {
  const kind = String(req.query.kind || ""), before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const rows = q.all(`SELECT a.id, a.user_id, a.kind, a.data_json, a.created_at, u.email, u.display_name FROM activity a LEFT JOIN users u ON u.id = a.user_id
                      WHERE a.id < ? AND (? = '' OR a.kind = ?) ORDER BY a.id DESC LIMIT 100`, before, kind, kind);
  res.json({
    kinds: q.all("SELECT kind, COUNT(*) AS n FROM activity GROUP BY kind ORDER BY n DESC"),
    items: rows.map((a) => ({ id: a.id, userId: a.user_id, email: a.email, name: a.display_name, kind: a.kind, data: json(a.data_json, {}), at: a.created_at })),
  });
});

adminRouter.get("/feedback", (_req, res) => res.json({ items: feedbackRows(200) }));

/* -------------------------------------- ads -------------------------------------- */

adminRouter.get("/ads", (_req, res) => res.json({ ads: adminAds() }));
adminRouter.post("/ads/:id", (req, res) => {
  try {
    res.json({ ad: decideAd(req.params.id, String(req.body?.action || ""), String(req.body?.note || "")) });
  } catch (e) {
    if (e instanceof AdError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

/* ------------------------------------- export ------------------------------------ */

const iso = (ms) => (ms ? new Date(ms).toISOString() : "");
const EXPORTS = {
  users: {
    sql: `SELECT u.id, u.email, u.display_name, u.created_at, u.last_seen_at, COALESCE(p.onboarded, 0) AS onboarded, r.email AS invited_by,
                 p.raw_text, p.chips_json, p.summary, p.avoid_json,
                 (SELECT COUNT(*) FROM impressions i WHERE i.user_id = u.id AND i.watched_ms > 0) AS clips,
                 (SELECT COALESCE(SUM(i.watched_ms), 0) FROM impressions i WHERE i.user_id = u.id) AS watched_ms,
                 (SELECT COALESCE(SUM(i.liked), 0) FROM impressions i WHERE i.user_id = u.id) AS likes
          FROM users u LEFT JOIN profiles p ON p.user_id = u.id LEFT JOIN users r ON r.id = u.referred_by ORDER BY u.created_at`,
    cols: [["user_id", (r) => r.id], ["email", (r) => r.email], ["name", (r) => r.display_name], ["joined", (r) => iso(r.created_at)], ["last_seen", (r) => iso(r.last_seen_at)],
      ["finished_setup", (r) => (r.onboarded ? "yes" : "no")], ["invited_by", (r) => r.invited_by || ""], ["what_they_typed_at_signup", (r) => r.raw_text || ""],
      ["topics_they_picked", (r) => json(r.chips_json, []).join(", ")], ["profile_summary", (r) => r.summary || ""], ["muted_topics", (r) => json(r.avoid_json, []).join(", ")],
      ["clips_watched", (r) => r.clips], ["minutes_watched", (r) => Math.round(r.watched_ms / 6000) / 10], ["likes", (r) => r.likes]],
  },
  activity: {
    sql: "SELECT a.created_at, u.email, a.kind, a.data_json FROM activity a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 200000",
    cols: [["time", (r) => iso(r.created_at)], ["email", (r) => r.email || ""], ["what", (r) => r.kind], ["details", (r) => r.data_json]],
  },
  watch_history: {
    sql: `SELECT i.served_at, u.email, v.source, v.title, v.creator, v.url, i.watched_ms, i.duration_ms, i.liked, i.shared, i.hidden, i.skipped, i.replays, i.reason, i.start_ms
          FROM impressions i JOIN users u ON u.id = i.user_id JOIN videos v ON v.id = i.video_id WHERE i.watched_ms > 0 OR i.finalized = 1 ORDER BY i.served_at DESC LIMIT 200000`,
    cols: [["time", (r) => iso(r.served_at)], ["email", (r) => r.email], ["platform", (r) => r.source], ["title", (r) => r.title], ["creator", (r) => r.creator], ["url", (r) => r.url],
      ["watched_seconds", (r) => Math.round(r.watched_ms / 100) / 10], ["clip_seconds", (r) => Math.round(r.duration_ms / 100) / 10],
      ["watched_percent", (r) => (r.duration_ms > 0 ? Math.round(Math.min(1, r.watched_ms / r.duration_ms) * 100) : "")],
      ["liked", (r) => r.liked], ["shared", (r) => r.shared], ["not_me", (r) => r.hidden], ["skipped", (r) => r.skipped], ["replays", (r) => r.replays],
      ["why_shown", (r) => r.reason], ["seconds_to_start", (r) => (r.start_ms ? Math.round(r.start_ms / 100) / 10 : "")]],
  },
  searches: {
    sql: "SELECT a.created_at, u.email, a.data_json FROM activity a LEFT JOIN users u ON u.id = a.user_id WHERE a.kind = 'search' ORDER BY a.id DESC LIMIT 200000",
    cols: [["time", (r) => iso(r.created_at)], ["email", (r) => r.email || ""], ["search", (r) => json(r.data_json, {}).q || ""], ["results", (r) => json(r.data_json, {}).results ?? ""]],
  },
  interests: {
    sql: "SELECT u.email, i.tag, i.weight, i.origin, i.impressions, i.positive FROM interests i JOIN users u ON u.id = i.user_id ORDER BY u.email, i.weight DESC",
    cols: [["email", (r) => r.email], ["topic", (r) => r.tag], ["weight", (r) => Math.round(r.weight * 100) / 100], ["where_it_came_from", (r) => r.origin], ["clips_seen", (r) => r.impressions], ["clips_enjoyed", (r) => r.positive]],
  },
  feedback: {
    sql: "SELECT a.created_at, u.email, u.display_name, a.data_json FROM activity a LEFT JOIN users u ON u.id = a.user_id WHERE a.kind = 'feedback' ORDER BY a.id DESC",
    cols: [["time", (r) => iso(r.created_at)], ["email", (r) => r.email || ""], ["name", (r) => r.display_name || ""], ["feedback", (r) => json(r.data_json, {}).text || ""]],
  },
  referrals: {
    sql: `SELECT o.email AS inviter, i.code, i.used_at, n.email AS invitee, COALESCE(p.onboarded, 0) AS onboarded
          FROM invites i JOIN users o ON o.id = i.user_id LEFT JOIN users n ON n.id = i.used_by LEFT JOIN profiles p ON p.user_id = i.used_by WHERE i.used_by IS NOT NULL ORDER BY i.used_at`,
    cols: [["inviter", (r) => r.inviter], ["link_code", (r) => r.code], ["used", (r) => iso(r.used_at)], ["new_member", (r) => r.invitee || ""], ["finished_setup", (r) => (r.onboarded ? "yes" : "no")]],
  },
};

// A cell that a spreadsheet would run as a formula is stored as text instead.
const cell = (v) => {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

adminRouter.get("/export/:name", (req, res) => {
  const name = String(req.params.name).replace(/\.csv$/, ""), spec = EXPORTS[name];
  if (!spec) return res.status(404).json({ error: "unknown export", available: Object.keys(EXPORTS) });
  const rows = q.all(spec.sql);
  const lines = [spec.cols.map(([h]) => h).join(","), ...rows.map((r) => spec.cols.map(([, f]) => cell(f(r))).join(","))];
  track(req.user.id, "export", { name, rows: rows.length });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="axol-${name}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(`﻿${lines.join("\r\n")}\r\n`);
});
