// A promoted clip opens every viewer's feed, holds it until watched through once, and is kept
// out of the taste model.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.AXOL_DB_PATH = ":memory:";
process.env.AXOL_DISABLE_AI = "1";
process.env.AXOL_PROMOTIONS_FILE = "/nonexistent/promotions.json";
delete process.env.APIFY_TOKEN;

const { loadCatalog, makeViewer } = await import("./helpers.js");
const { q } = await import("../src/db.js");
const { openingItems, isPromoImpression, promotionStats } = await import("../src/promotions.js");

loadCatalog();
const VID = "ski-racing"; // a YouTube clip in the fixture catalog
const DAY = 86400e3, T = Date.now();
q.run("INSERT INTO promotions (video_id, label, cta_label, cta_url, starts_at, ends_at) VALUES (?, 'Promoted', 'Subscribe to Someone on YouTube', 'https://www.youtube.com/@someone?sub_confirmation=1', ?, ?)", VID, T - DAY, T + 6 * DAY);

test("a promoted clip opens the feed for every viewer, labelled as a promotion", () => {
  for (const viewer of [makeViewer([{ tag: "cooking", weight: 3, positive: 4 }]), makeViewer([], { avoid: ["skiing"] })]) {
    const [item, ...rest] = openingItems(viewer);
    assert.equal(rest.length, 0);
    assert.equal(item.id, VID);
    assert.equal(item.why.kind, "promoted");
    assert.equal(item.reason, "Promoted");
    assert.match(item.why.detail, /not picked from your history/);
    assert.equal(item.promo.mustWatch, true);
    assert.equal(item.promo.cta.url, "https://www.youtube.com/@someone?sub_confirmation=1");
    assert.deepEqual(item.topics, []);
    assert.ok(isPromoImpression(q.get("SELECT * FROM impressions WHERE id = ?", item.impressionId)));
  }
});

test("the hold ends once the viewer has watched it through; 'Not me' afterwards removes it", () => {
  const viewer = makeViewer();
  const [first] = openingItems(viewer);
  const duration = q.get("SELECT duration_ms FROM videos WHERE id = ?", VID).duration_ms || 20000;
  q.run("UPDATE impressions SET watched_ms = ? WHERE id = ?", Math.round(duration * 0.5), first.impressionId);
  assert.equal(openingItems(viewer)[0].promo.mustWatch, true, "half watched still holds");
  q.run("UPDATE impressions SET watched_ms = ? WHERE id = ?", duration, first.impressionId);
  const [again] = openingItems(viewer);
  assert.equal(again.promo.mustWatch, false);
  q.run("UPDATE impressions SET hidden = 1 WHERE id = ?", again.impressionId);
  assert.equal(openingItems(viewer).length, 0);
});

test("it stops when the promotion ends, and reports its reach", () => {
  const viewer = makeViewer();
  assert.equal(openingItems(viewer, T + 7 * DAY).length, 0);
  const [s] = promotionStats();
  assert.ok(s.viewers >= 3 && s.shown >= s.viewers);
  assert.equal(s.channel, "https://www.youtube.com/@someone?sub_confirmation=1");
});

test("an ordinary impression of another clip is not treated as a promotion", () => {
  const viewer = makeViewer();
  q.run("INSERT INTO impressions (id, user_id, video_id, served_at, duration_ms, reason, updated_at) VALUES ('plain-1', ?, 'rap-freestyle', ?, 20000, 'Promoted', ?)", viewer, T, T);
  assert.equal(isPromoImpression(q.get("SELECT * FROM impressions WHERE id = 'plain-1'")), false);
});
