// Regression tests for search relevance, explanation accuracy and steering.
// They run against a small fixed catalog (test/fixtures/catalog.js) in an in-memory database.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.AXOL_DB_PATH = ":memory:";
process.env.AXOL_DISABLE_AI = "1";
// A YouTube key with a zero daily budget: "quota reached" without touching the network.
process.env.YOUTUBE_API_KEY = "test-key-not-real";
process.env.YOUTUBE_DAILY_UNITS = "0";
delete process.env.APIFY_TOKEN;

const { CATALOG, byId } = await import("./fixtures/catalog.js");
const { loadCatalog, makeViewer, serveQueue, interestsOf } = await import("./helpers.js");
const { q } = await import("../src/db.js");
const { rankSearch, searchCatalog, hydrate, broaden } = await import("../src/search.js");
const { buildModel, scoreVideo, rankBatch, DISCOVERY_LABEL } = await import("../src/ranker.js");
const { steerFeed, clipIsAbout, SteerError } = await import("../src/feedService.js");
const { boostTopic, muteTopic } = await import("../src/preferences.js");
const { getProfile } = await import("../src/profileService.js");
const { learnFromImpression } = await import("../src/learner.js");
const { topicKey } = await import("../src/topics.js");

loadCatalog();
const ids = (list) => list.map((e) => e.video.id);
const mid = () => 0.5; // fixed "random" so ordering is deterministic

/* ------------------------------------ 1. search ------------------------------------ */

test("search: \"freestyle skiing\" returns the skiing clip, not everything containing \"freestyle\"", () => {
  const { strong, related } = rankSearch(CATALOG, "freestyle skiing");
  assert.deepEqual(ids(strong), ["ski-freestyle"], "one strong match exists, so exactly one is shown");
  for (const junk of ["bmx-1", "bmx-2", "bmx-3", "rap-freestyle", "hoops-1", "hoops-2"]) {
    assert.ok(!ids(strong).includes(junk) && !ids(related).includes(junk), `${junk} must not appear for "freestyle skiing"`);
  }
  // Other skiing is on-topic but not the whole query: offered separately, never mixed in.
  assert.deepEqual(ids(related), ["ski-racing"]);
  assert.deepEqual(related[0].missing, ["freestyle"]);
});

test("search: a substring is not a word (\"ski\" does not match \"skills\")", () => {
  const { strong, related } = rankSearch(CATALOG, "skiing");
  assert.deepEqual(ids(strong).sort(), ["ski-freestyle", "ski-racing"]);
  assert.equal(related.length, 0);
});

test("search: \"AI tools\" needs both words; tools-only and AI-only clips are not results", () => {
  const { strong } = rankSearch(CATALOG, "AI tools");
  assert.deepEqual(ids(strong).sort(), ["ai-1", "ai-2", "ai-3"]);
});

test("search: no relevant clip means an empty result, not near-misses", () => {
  const viewer = makeViewer();
  const res = searchCatalog(viewer, "underwater hockey");
  assert.equal(res.total, 0);
  assert.deepEqual(res.items, []);
  assert.deepEqual(res.ids, []);
  assert.equal(res.relatedTotal, 0);
  // One word present elsewhere ("freestyle") must not rescue an unrelated query either.
  assert.equal(searchCatalog(viewer, "freestyle chess", { remember: false }).total, 0);
});

test("search: the count, the grid and the swipeable player are one list", () => {
  const viewer = makeViewer();
  const res = searchCatalog(viewer, "AI tools", { n: 2 });
  assert.equal(res.total, 3);
  assert.equal(res.ids.length, res.total, "the count is the length of the list that will be shown");
  assert.deepEqual(res.items.map((i) => i.id), res.ids.slice(0, 2), "the first page is the head of that list");
  // The player pages by id from the same list, so it cannot wander outside the results.
  const more = hydrate(viewer, "AI tools", res.ids.slice(2));
  assert.deepEqual(more.map((i) => i.id), res.ids.slice(2));
  const shown = new Set([...res.items, ...more].map((i) => i.id));
  assert.deepEqual([...shown].sort(), [...res.ids].sort());
  for (const it of [...res.items, ...more]) assert.equal(it.why.kind, "search");
  // An id that is not a playable catalog clip is never served.
  assert.deepEqual(hydrate(viewer, "AI tools", ["no-such-clip"]), []);
});

test("search: with the daily quota spent, cached matches are still judged the same way and nothing is fetched", async () => {
  const viewer = makeViewer();
  const res = searchCatalog(viewer, "freestyle skiing");
  assert.deepEqual(res.ids, ["ski-freestyle"], "quota state does not loosen or change relevance");
  assert.deepEqual(res.discovery.paused, ["youtube"]);
  assert.deepEqual(res.discovery.available, []);
  // The optional broaden action reports the pause and attempts no live search.
  const before = q.get("SELECT COUNT(*) AS n FROM videos").n;
  const out = await broaden(viewer, "freestyle skiing");
  assert.deepEqual(out.started, []);
  assert.deepEqual(out.paused, ["youtube"]);
  assert.equal(q.get("SELECT COUNT(*) AS n FROM videos").n, before);
  assert.equal(q.get("SELECT COUNT(*) AS n FROM query_runs").n, 0, "no search was recorded as run");
});

test("search: searching records the interest once, under the topic's existing name", () => {
  const viewer = makeViewer([{ tag: "tools-ai", weight: 1, positive: 2 }]);
  searchCatalog(viewer, "AI tools");
  const rows = interestsOf(viewer);
  assert.equal(rows.length, 1, "no duplicate row for the same topic under another word order");
  assert.equal(rows[0].tag, "tools-ai");
  assert.ok(rows[0].weight > 1);
});

/* --------------------------------- 2. explanations --------------------------------- */

const motoFan = () => buildModel({ interests: [{ tag: "stunt-motocross-rider-pov", weight: 3, positive: 6, impressions: 8, origin: "learned" }], totalViews: 30 });

test("explanation: a coffee clip is not explained by a motocross interest that shares only \"pov\"", () => {
  const s = scoreVideo(byId["coffee-pov"], motoFan(), { rand: mid });
  assert.equal(s.match, 0, "a shared format word adds nothing to the ranking either");
  assert.equal(s.why.kind, "discovery");
  assert.equal(s.why.label, DISCOVERY_LABEL);
  assert.ok(!/motocross/i.test(s.why.label + s.why.detail));
  assert.equal(s.explanation, s.why.label, "the short label and the Why panel come from one object");
});

test("explanation: \"Because you watch\" needs the viewer's history AND the clip's content", () => {
  const moto = scoreVideo(byId["moto-pov"], motoFan(), { rand: mid });
  assert.equal(moto.why.kind, "watch");
  assert.match(moto.why.label, /^Because you watch .*motocross/);
  assert.match(moto.why.detail, /6 .*clips/);

  const coffeeFan = buildModel({ interests: [{ tag: "specialty-coffee", weight: 2.5, positive: 4, impressions: 5 }], totalViews: 20 });
  const coffee = scoreVideo(byId["coffee-tutorial"], coffeeFan, { rand: mid });
  assert.equal(coffee.why.kind, "watch");
  assert.equal(coffee.why.label, "Because you watch coffee", "names the common ground, which the clip really has");
  // The same viewer gets no coffee claim on a motocross clip.
  assert.equal(scoreVideo(byId["moto-race"], coffeeFan, { rand: mid }).why.kind, "discovery");
});

test("explanation: stated-but-unwatched interests say \"asked for\"; unconfirmed guesses are discovery", () => {
  const asked = buildModel({ interests: [{ tag: "coffee", weight: 2.5, positive: 0, origin: "onboarding" }] });
  const a = scoreVideo(byId["coffee-tutorial"], asked, { rand: mid });
  assert.equal(a.why.kind, "asked");
  assert.equal(a.why.label, "Because you asked for coffee");

  const guessed = buildModel({ interests: [{ tag: "coffee", weight: 2.5, positive: 0, origin: "ai" }] });
  const g = scoreVideo(byId["coffee-tutorial"], guessed, { rand: mid });
  assert.equal(g.why.kind, "discovery");
  assert.equal(g.why.label, DISCOVERY_LABEL);
});

test("explanation: several tags pointing at one interest add up instead of cancelling the reason", () => {
  // The viewer's interest is "rock-climbing"; the clip says the same thing three ways.
  const clip = { id: "climb", source: "youtube", created_at: Date.now(), creator: "", media_file: "",
    tags_json: JSON.stringify([{ tag: "climbing", relevance: 1 }, { tag: "bouldering", relevance: 0.9 }, { tag: "climbing-gym", relevance: 0.8 }, { tag: "highlight", relevance: 0.5 }]) };
  const asked = buildModel({ interests: [{ tag: "rock-climbing", weight: 2.3, positive: 0, origin: "onboarding" }, { tag: "bouldering", weight: 1.4, positive: 0, origin: "ai" }] });
  const a = scoreVideo(clip, asked, { rand: mid });
  assert.equal(a.why.kind, "asked");
  assert.equal(a.why.label, "Because you asked for climbing");
  // Likewise for a BMX taste stored under a narrower name.
  const bmx = scoreVideo(byId["bmx-2"], buildModel({ interests: [{ tag: "bmx-riding", weight: 2.4, positive: 5 }] }), { rand: mid });
  assert.equal(bmx.why.label, "Because you watch BMX");
});

test("explanation: every clip in a ranked batch carries its own consistent reason", () => {
  const model = buildModel({ interests: [{ tag: "motocross", weight: 3, positive: 5 }, { tag: "coffee", weight: 2, positive: 3 }], totalViews: 20 });
  const batch = rankBatch(CATALOG, model, 8, { rand: mid, wild: false });
  for (const p of batch) {
    assert.equal(p.explanation, p.why.label);
    const tags = JSON.parse(p.video.tags_json).map((t) => t.tag).join(" ");
    if (p.why.kind === "watch") {
      const topic = p.why.label.replace("Because you watch ", "");
      assert.ok(tags.includes(topic.split(" ")[0]), `"${p.why.label}" on ${p.video.id} must be backed by its tags (${tags})`);
    }
  }
  assert.ok(batch.some((p) => p.why.kind === "watch") && batch.some((p) => p.why.kind === "discovery"));
});

test("learning: watching a coffee POV to the end does not strengthen a motocross-POV interest", () => {
  const viewer = makeViewer([{ tag: "stunt-motocross-rider-pov", weight: 2, positive: 3 }]);
  const [imp] = serveQueue(viewer, ["coffee-pov"]);
  q.run("UPDATE impressions SET watched_ms = 20000 WHERE id = ?", imp);
  learnFromImpression(viewer, q.get("SELECT * FROM impressions WHERE id = ?", imp), byId["coffee-pov"]);
  const moto = interestsOf(viewer).find((r) => r.tag === "stunt-motocross-rider-pov");
  assert.ok(moto.weight <= 2, "only global decay may touch it");
  assert.equal(moto.impressions, 3, "the coffee clip was not counted as a motocross view");
});

/* ----------------------------------- 3. steering ----------------------------------- */

test("topics: \"motocross-big-air\" and \"big-air-motocross\" are one topic and one control", () => {
  assert.equal(topicKey("motocross-big-air"), topicKey("big-air-motocross"));
  const viewer = makeViewer([
    { tag: "motocross-big-air", weight: 1.2, positive: 3, impressions: 4, origin: "learned" },
    { tag: "big-air-motocross", weight: 0.6, positive: 1, impressions: 2, origin: "ai" },
  ]);
  const profile = getProfile(viewer);
  assert.equal(profile.interests.length, 1, "the profile shows it once");
  assert.equal(profile.interests[0].tag, "motocross-big-air");
  assert.ok(Math.abs(profile.interests[0].weight - 1.8) < 1e-9);
  assert.deepEqual(profile.interests[0].aliases, ["big-air-motocross"]);

  // Boosting either name boosts the topic and keeps everything learned under both.
  boostTopic(viewer, "big-air-motocross");
  const rows = interestsOf(viewer);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tag, "motocross-big-air");
  assert.ok(Math.abs(rows[0].weight - 2.8) < 1e-9, "1.2 + 0.6 preserved, +1 for the boost");
  assert.equal(rows[0].positive, 4);
  assert.equal(rows[0].impressions, 6);

  // Muting under one name blocks clips tagged with the other.
  muteTopic(viewer, "big-air-motocross");
  assert.equal(interestsOf(viewer).length, 0);
  assert.equal(scoreVideo(byId["moto-bigair"], buildModel({ avoid: getProfile(viewer).avoid }), { rand: mid }), null);
});

test("steer: Less BMX swaps BMX out of the already-loaded queue and leaves the current clip alone", () => {
  const viewer = makeViewer([{ tag: "bmx", weight: 3, positive: 8, impressions: 9 }, { tag: "coffee", weight: 1.5, positive: 3 }]);
  const [current, ...queue] = serveQueue(viewer, ["bmx-1", "bmx-2", "coffee-tutorial", "bmx-3", "ai-1"]);
  q.run("UPDATE impressions SET watched_ms = 4000 WHERE id = ?", current); // it is playing

  const out = steerFeed(viewer, { impressionId: current, tag: "bmx", direction: "less", queue }, { rand: mid });
  const after = out.queue.map((i) => i.id);
  assert.equal(out.removed, 2);
  assert.equal(out.added, 2);
  assert.equal(after.length, queue.length, "the queue keeps its length when replacements exist");
  assert.ok(after.every((id) => !clipIsAbout(byId[id], "bmx")), `no BMX left in the queue: ${after}`);
  assert.equal(out.inNextThree, 0, "noticeable within the next three swipes");
  assert.equal(after[1], "coffee-tutorial", "clips that were fine keep their place");
  assert.equal(after[3], "ai-1");
  assert.match(out.message, /Less BMX: swapped 2 upcoming clips/);

  // The clip being watched is untouched: same impression, same progress.
  assert.equal(q.get("SELECT watched_ms FROM impressions WHERE id = ?", current).watched_ms, 4000);
  // Kept clips keep their impression ids (the player does not reload them); swapped ones are new.
  assert.equal(out.queue[1].impressionId, queue[1]);
  assert.equal(q.get("SELECT COUNT(*) AS n FROM impressions WHERE id IN (?, ?)", queue[0], queue[2]).n, 0, "unplayed BMX impressions are released");
  // The preference is a down-weight, not a hard mute.
  const bmx = interestsOf(viewer).find((r) => r.tag === "bmx");
  assert.ok(bmx.weight < 0);
  assert.deepEqual(getProfile(viewer).avoid, []);
});

test("steer: Less BMX lasts beyond the loaded queue, even when the interest is stored under a narrower name", () => {
  // The viewer's BMX taste lives in "bmx-riding" and "freestyle-bmx", not in a row called "bmx".
  const viewer = makeViewer([
    { tag: "bmx-riding", weight: 2.4, positive: 6, origin: "onboarding" },
    { tag: "freestyle-bmx", weight: 0.6, positive: 1, origin: "ai" },
    { tag: "coffee", weight: 1, positive: 2 },
  ]);
  const before = rankBatch(CATALOG, buildModel({ interests: interestsOf(viewer) }), 3, { rand: mid, wild: false });
  assert.ok(clipIsAbout(before[0].video, "bmx") && clipIsAbout(before[1].video, "bmx") && before[0].match > 0.5, "BMX leads this viewer's ranking beforehand");

  const [current, ...queue] = serveQueue(viewer, ["bmx-1", "bmx-2", "ai-1"]);
  steerFeed(viewer, { impressionId: current, tag: "bmx", direction: "less", queue }, { rand: mid });

  const rows = interestsOf(viewer);
  assert.equal(rows.find((r) => r.tag === "bmx-riding").weight, 0, "the narrower interest is neutralized, not deleted");
  assert.equal(rows.find((r) => r.tag === "bmx-riding").positive, 6, "its history is kept");
  assert.ok(rows.find((r) => r.tag === "bmx").weight < 0);
  assert.ok(rows.find((r) => r.tag === "coffee").weight === 1, "unrelated preferences are untouched");
  // Every later batch ranks against the same model: BMX no longer scores above neutral.
  const model = buildModel({ interests: rows });
  for (const id of ["bmx-1", "bmx-2", "bmx-3"]) assert.ok(scoreVideo(byId[id], model, { rand: mid }).match < 0, `${id} should now rank below neutral`);
  const after = rankBatch(CATALOG, model, 6, { rand: mid, wild: false });
  assert.ok(after.every((p) => !clipIsAbout(p.video, "bmx")), `no BMX in the next batch: ${after.map((p) => p.video.id)}`);
});

test("steer: More puts matching clips within the next three when there is inventory", () => {
  const viewer = makeViewer([{ tag: "coffee", weight: 2, positive: 4 }]);
  const [current, ...queue] = serveQueue(viewer, ["moto-race", "ai-1", "coffee-tutorial", "ai-2", "hoops-1"]);
  const out = steerFeed(viewer, { impressionId: current, tag: "motocross", direction: "more", queue }, { rand: mid });
  const nextThree = out.queue.slice(0, 3).map((i) => i.id);
  assert.ok(out.inNextThree >= 1 && out.inNextThree <= 2);
  assert.ok(nextThree.some((id) => clipIsAbout(byId[id], "motocross")), `expected motocross in ${nextThree}`);
  assert.match(out.message, /in your next three clips/);
  assert.equal(out.inventory, "ok");
  for (const id of queue) assert.ok(out.queue.some((i) => i.impressionId === id), "nothing already loaded is thrown away");
  const added = out.queue.find((i) => clipIsAbout(byId[i.id], "motocross"));
  assert.equal(added.why.label, "Because you asked for motocross");
});

test("steer: with no matching inventory, More is recorded without promising an immediate match", () => {
  const viewer = makeViewer();
  const [current, ...queue] = serveQueue(viewer, ["rap-freestyle", "ai-1", "coffee-tutorial"]);
  const out = steerFeed(viewer, { impressionId: current, tag: "hip-hop", direction: "more", queue }, { rand: mid });
  assert.equal(out.inNextThree, 0);
  assert.equal(out.inventory, "thin");
  assert.match(out.message, /noted/i);
  assert.ok(!/next three|coming up/i.test(out.message));
  assert.deepEqual(out.queue.map((i) => i.id), ["ai-1", "coffee-tutorial"], "the queue is left as it was");
  assert.ok(interestsOf(viewer).find((r) => r.tag === "hip-hop").weight > 0, "the preference is still saved");
});

test("steer: only topics that describe the current clip can be steered from it", () => {
  const viewer = makeViewer();
  const [current] = serveQueue(viewer, ["coffee-tutorial"]);
  assert.throws(() => steerFeed(viewer, { impressionId: current, tag: "bmx", direction: "less", queue: [] }), SteerError);
  // Format tags are not offered: "tutorial" is how the clip is made, not what it is about.
  assert.throws(() => steerFeed(viewer, { impressionId: current, tag: "tutorial", direction: "less", queue: [] }), SteerError);
  const [item] = hydrate(viewer, "coffee", ["coffee-tutorial"]);
  assert.deepEqual(item.topics.map((t) => t.label), ["coffee", "espresso"]);
});
