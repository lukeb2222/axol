// Invite links, the earned ad, sponsored placement, the activity log and the owner's exports.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.AXOL_DB_PATH = ":memory:";
process.env.AXOL_DISABLE_AI = "1";
process.env.AXOL_PROMOTIONS_FILE = "/nonexistent/promotions.json";
delete process.env.APIFY_TOKEN;
delete process.env.YOUTUBE_API_KEY;

const { loadCatalog, makeViewer } = await import("./helpers.js");
const { q, uid, now } = await import("../src/db.js");
const { track } = await import("../src/activity.js");
const { referralState, redeemInvite, decideAd, sponsoredItem, adminAds, AdError, submitAd, INVITES_PER_MEMBER } = await import("../src/referrals.js");
const { isPromoImpression } = await import("../src/promotions.js");

loadCatalog();
const AD_VIDEO = "ski-racing"; // a YouTube clip in the fixture catalog
const newcomer = (onboarded) => {
  const id = makeViewer();
  q.run("UPDATE profiles SET onboarded = ? WHERE user_id = ?", onboarded ? 1 : 0, id);
  return id;
};
const pendingAd = (userId) => {
  const id = uid();
  q.run("INSERT INTO ads (id, user_id, video_id, url, cta_label, cta_url, status, created_at) VALUES (?, ?, ?, 'https://www.youtube.com/shorts/x', 'Subscribe to Someone on YouTube', 'https://www.youtube.com/@someone?sub_confirmation=1', 'pending', ?)", id, userId, AD_VIDEO, now());
  return id;
};

test("every member gets ten single-use invite links, and the same ten each time", () => {
  const member = makeViewer();
  const a = referralState(member), b = referralState(member);
  assert.equal(a.invites.length, INVITES_PER_MEMBER);
  assert.equal(new Set(a.invites.map((i) => i.code)).size, INVITES_PER_MEMBER);
  assert.deepEqual(a.invites.map((i) => i.code), b.invites.map((i) => i.code));
  assert.ok(a.invites.every((i) => i.status === "open"));
  assert.equal(a.adAvailable, false);
});

test("a link works once, never for its own owner, and the ad unlocks when the friend finishes setup", () => {
  const member = makeViewer();
  const [first, second] = referralState(member).invites.map((i) => i.code);
  assert.equal(redeemInvite(first, member), null, "own link");
  assert.equal(redeemInvite("not-a-code", newcomer(true)), null);

  const friend = newcomer(false);
  assert.equal(redeemInvite(first.toUpperCase(), friend), member, "codes are case-insensitive");
  assert.equal(q.get("SELECT referred_by FROM users WHERE id = ?", friend).referred_by, member);
  assert.equal(redeemInvite(first, newcomer(true)), null, "already used");

  let st = referralState(member);
  assert.equal(st.invites.find((i) => i.code === first).status, "signed_up");
  assert.equal(st.joined, 0);
  assert.equal(st.adAvailable, false, "signing up alone does not earn the ad");

  q.run("UPDATE profiles SET onboarded = 1 WHERE user_id = ?", friend);
  st = referralState(member);
  assert.equal(st.joined, 1);
  assert.equal(st.adAvailable, true);

  // More friends do not earn more ads: it is one ad per member.
  redeemInvite(second, newcomer(true));
  pendingAd(member);
  st = referralState(member);
  assert.equal(st.joined, 2);
  assert.equal(st.adAvailable, false);
  assert.equal(st.ads[0].state, "pending");
});

test("an ad cannot be submitted before it is earned, or with something that is not a YouTube link", async () => {
  const member = makeViewer();
  await assert.rejects(() => submitAd(member, "https://www.youtube.com/shorts/gSulTfsneC0"), AdError);
  redeemInvite(referralState(member).invites[0].code, newcomer(true));
  await assert.rejects(() => submitAd(member, "https://example.com/video"), /YouTube Shorts link/);
});

test("nothing is shown until the owner approves; then it is a labelled, skippable clip, once a day per viewer", () => {
  const member = makeViewer(), viewer = makeViewer();
  const ad = pendingAd(member);
  assert.equal(sponsoredItem(viewer), null, "pending ads never run");

  const approved = decideAd(ad, "approve");
  assert.equal(approved.state, "running");
  assert.equal(approved.member.id, member);
  const item = sponsoredItem(viewer);
  assert.equal(item.id, AD_VIDEO);
  assert.equal(item.reason, "Sponsored");
  assert.equal(item.why.kind, "sponsored");
  assert.equal(item.promo.mustWatch, false);
  assert.match(item.promo.cta.url, /sub_confirmation=1/);
  assert.ok(isPromoImpression(q.get("SELECT * FROM impressions WHERE id = ?", item.impressionId)), "kept out of the taste model");
  assert.equal(sponsoredItem(viewer), null, "not twice in a day");
  assert.ok(sponsoredItem(viewer, new Set(), now() + 25 * 3600e3), "again the next day");
  assert.equal(sponsoredItem(makeViewer(), new Set([AD_VIDEO])), null, "not when that clip is already in the batch");

  const other = makeViewer();
  const shown = sponsoredItem(other);
  q.run("UPDATE impressions SET hidden = 1 WHERE id = ?", shown.impressionId);
  assert.equal(sponsoredItem(other, new Set(), now() + 25 * 3600e3), null, "never again after Not me");

  assert.equal(sponsoredItem(makeViewer(), new Set(), now() + 8 * 86400e3), null, "stops after its week");
  assert.equal(decideAd(ad, "end").state, "ended");
  assert.equal(sponsoredItem(makeViewer()), null);
  assert.throws(() => decideAd(ad, "approve"), AdError);
});

test("a rejected ad gives the member their ad back", () => {
  const member = makeViewer();
  redeemInvite(referralState(member).invites[0].code, newcomer(true));
  const ad = pendingAd(member);
  assert.equal(referralState(member).adAvailable, false);
  assert.equal(decideAd(ad, "reject", "not a Short").state, "rejected");
  const st = referralState(member);
  assert.equal(st.adAvailable, true);
  assert.equal(st.ads[0].note, "not a Short");
  assert.ok(adminAds().some((a) => a.id === ad && a.state === "rejected"));
});

test("the activity log records what people type, and never breaks on odd input", () => {
  const member = makeViewer();
  track(member, "search", { q: "underwater hockey", results: 0 });
  track(member, "feedback", { text: "=HYPERLINK(\"http://x\")" });
  const cyc = {}; cyc.self = cyc;
  assert.doesNotThrow(() => track(member, "weird", cyc));
  const rows = q.all("SELECT kind, data_json FROM activity WHERE user_id = ? ORDER BY id", member);
  assert.deepEqual(rows.map((r) => r.kind), ["search", "feedback"]);
  assert.equal(JSON.parse(rows[0].data_json).q, "underwater hockey");
});

test("deleting an account removes what was recorded about it", async () => {
  const express = (await import("express")).default;
  const { adminRouter } = await import("../src/routes/admin.js");
  const owner = makeViewer(), member = makeViewer();
  q.run("UPDATE users SET is_admin = 1 WHERE id = ?", owner);
  track(member, "search", { q: "bmx" });
  referralState(member);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = q.get("SELECT id, email, display_name, is_admin FROM users WHERE id = ?", req.headers["x-user"]); next(); });
  app.use("/admin", adminRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/admin`;
  try {
    assert.equal((await fetch(`${base}/overview`, { headers: { "x-user": member } })).status, 403, "members cannot open the owner view");
    const ov = await (await fetch(`${base}/overview`, { headers: { "x-user": owner } })).json();
    assert.ok(ov.totals.users >= 2 && ov.daily.length === 14 && ov.funnel.length === 5);
    const csv = await (await fetch(`${base}/export/feedback.csv`, { headers: { "x-user": owner } })).text();
    assert.match(csv, /'=HYPERLINK/, "spreadsheet formulas are exported as text");
    assert.equal((await fetch(`${base}/users/${member}`, { method: "DELETE", headers: { "x-user": owner } })).status, 200);
    assert.equal(q.get("SELECT COUNT(*) AS n FROM users WHERE id = ?", member).n, 0);
    assert.equal(q.get("SELECT COUNT(*) AS n FROM activity WHERE user_id = ?", member).n, 0);
    assert.equal(q.get("SELECT COUNT(*) AS n FROM invites WHERE user_id = ?", member).n, 0);
  } finally { server.close(); }
});
