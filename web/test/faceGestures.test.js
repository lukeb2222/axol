// Wink, head-tilt, brow-raise and laugh detectors over hand-made traces.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createWinkDetector, createTiltDetector, createBrowDetector, createLaughDetector,
  headAngles, blendScores, SENSITIVITY,
} from "../src/lib/gestures.js";

const count = (detector, list) => list.filter((r) => detector.push(r)).length;

/** Sample a piecewise-constant timeline [[t, fields], …] every 83ms. Each point's fields last until the next point. */
function series(points, extra = {}) {
  const out = [];
  for (let t = points[0][0]; t <= points.at(-1)[0]; t += 83) {
    let fields = points[0][1];
    for (const [pt, f] of points) { if (pt <= t) fields = f; else break; }
    out.push({ t, face: true, ...extra, ...fields });
  }
  return out;
}

test("blendScores reads the names MediaPipe uses and treats missing ones as 0", () => {
  const s = blendScores([
    { categoryName: "jawOpen", score: 0.4 },
    { categoryName: "eyeBlinkLeft", score: 0.8 },
    { categoryName: "eyeBlinkRight", score: 0.1 },
    { categoryName: "browInnerUp", score: 0.5 },
    { categoryName: "mouthSmileLeft", score: 0.6 },
    { categoryName: "mouthSmileRight", score: 0.4 },
  ]);
  assert.equal(s.jaw, 0.4);
  assert.equal(s.blinkL, 0.8);
  assert.equal(s.blinkR, 0.1);
  assert.equal(s.brow, 0.5);
  assert.equal(s.smile, 0.5);
  assert.equal(blendScores([]).smile, 0);
  assert.equal(blendScores(undefined).blinkL, 0);
});

test("headAngles reports a signed roll for a head tipped sideways in an upright picture", () => {
  const tipped = (rollDeg) => {
    const r = (rollDeg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    // Second column (the head's up) is tipped by rollDeg in the picture: atan2(m[4], m[5]) = rollDeg.
    return [c, -s, 0, 0,  s, c, 0, 0,  0, 0, 1, 0,  0, 0, 0, 1];
  };
  assert.ok(Math.abs(headAngles(tipped(20)).roll - 20) < 1e-6);
  assert.ok(Math.abs(headAngles(tipped(-15)).roll + 15) < 1e-6);
  assert.ok(Math.abs(headAngles(tipped(20)).pitch) < 1e-6);
});

test("a held wink fires once; a normal blink never does, at any sensitivity", () => {
  const open = { blinkL: 0.08, blinkR: 0.08 };
  const winkL = { blinkL: 0.85, blinkR: 0.1 };
  const blink = { blinkL: 0.85, blinkR: 0.8 };
  const held = series([[0, open], [400, winkL], [900, open], [1400, open]]);
  assert.equal(count(createWinkDetector(SENSITIVITY.normal.wink), held), 1, "deliberate wink");

  const blinked = series([[0, open], [400, blink], [550, open], [1200, open]]);
  for (const level of Object.values(SENSITIVITY)) {
    assert.equal(count(createWinkDetector(level.wink), blinked), 0, "both-eye blink");
  }

  const blip = series([[0, open], [400, winkL], [480, open], [900, open]]);
  assert.equal(count(createWinkDetector(), blip), 0, "too brief");
});

test("a blink where one eye leads is still a blink, not a wink", () => {
  const open = { blinkL: 0.08, blinkR: 0.08 };
  // Left eye closes 80ms first, then both are closed, then both open.
  const list = series([
    [0, open],
    [400, { blinkL: 0.85, blinkR: 0.1 }],
    [480, { blinkL: 0.85, blinkR: 0.8 }],
    [640, open], [1200, open],
  ]);
  assert.equal(count(createWinkDetector(), list), 0);
});

test("a wink re-arms after both eyes open, and missing readings never fire", () => {
  const open = { blinkL: 0.08, blinkR: 0.08 };
  const wink = { blinkL: 0.1, blinkR: 0.85 };
  const two = series([
    [0, open],
    [300, wink], [700, open],
    [1400, wink], [1800, open], [2000, open],
  ]);
  assert.equal(count(createWinkDetector(), two), 2);

  const zeros = [];
  for (let t = 0; t < 2000; t += 83) zeros.push({ t, face: true });
  assert.equal(count(createWinkDetector(), zeros), 0);
});

test("a head tilt down-and-back scrolls back; holding a tilt or nodding does not", () => {
  const rest = [[0, { roll: 0, pitch: 0, yaw: 0 }], [1200, { roll: 0, pitch: 0, yaw: 0 }]];
  const tip = series([...rest, [1400, { roll: 24, pitch: 0, yaw: 0 }], [1600, { roll: 24 }], [1800, { roll: 0 }], [2800, { roll: 0 }]]);
  assert.equal(count(createTiltDetector(), tip), 1, "tip and back");

  const left = series([...rest, [1400, { roll: -24 }], [1600, { roll: -24 }], [1800, { roll: 0 }], [2800, { roll: 0 }]]);
  assert.equal(count(createTiltDetector(), left), 1, "the other side also counts");

  const held = series([...rest, [1400, { roll: 26 }], [4000, { roll: 26 }], [4200, { roll: 0 }], [5000, { roll: 0 }]]);
  assert.equal(count(createTiltDetector(), held), 0, "held the head tilted");

  const nod = series([...rest, [1400, { roll: 0, pitch: 18 }], [1600, { roll: 0, pitch: 18 }], [1800, { roll: 0, pitch: 0 }], [2800, { roll: 0, pitch: 0 }]]);
  assert.equal(count(createTiltDetector(), nod), 0, "a nod is not a tilt");

  const small = series([...rest, [1400, { roll: 10 }], [1600, { roll: 10 }], [1800, { roll: 0 }], [2800, { roll: 0 }]]);
  assert.equal(count(createTiltDetector(SENSITIVITY.normal.tilt), small), 0, "under the normal threshold");
  assert.equal(count(createTiltDetector(SENSITIVITY.high.tilt), series([...rest, [1400, { roll: 16 }], [1600, { roll: 16 }], [1800, { roll: 0 }], [2800, { roll: 0 }]])), 1, "sensitive setting accepts a smaller tilt");

  const sideways = series([...rest, [1400, { roll: 60 }], [1600, { roll: 60 }], [1800, { roll: 0 }], [2800, { roll: 0 }]]);
  assert.equal(count(createTiltDetector(), sideways), 0, "a sideways picture is not a tilt");

  const lookingDown = series([...rest, [1400, { roll: 24, pitch: 35 }], [1600, { roll: 24, pitch: 35 }], [1800, { roll: 0, pitch: 0 }], [2800, { roll: 0 }]]);
  assert.equal(count(createTiltDetector(), lookingDown), 0, "ignored while looking down");
});

test("raised brows fire once when held; a flash or talking does not", () => {
  const rest = { brow: 0.06, jaw: 0.02 };
  const up = { brow: 0.55, jaw: 0.02 };
  const held = series([[0, rest], [400, up], [900, rest], [1400, rest]]);
  assert.equal(count(createBrowDetector(), held), 1);

  const flash = series([[0, rest], [400, up], [480, rest], [900, rest]]);
  assert.equal(count(createBrowDetector(), flash), 0);

  // Jaw opening and closing quickly while the brows are up = talking, not a raise.
  const talkPts = [[0, rest], [400, rest]];
  for (let t = 400, i = 0; t <= 1400; t += 83, i++) {
    talkPts.push([t, { brow: 0.55, jaw: i % 2 === 0 ? 0.35 : 0.02 }]);
  }
  talkPts.push([1500, rest], [1800, rest]);
  assert.equal(count(createBrowDetector(), series(talkPts)), 0, "talking");
});

test("a sudden held smile is a laugh; a resting or slowly growing smile is not", () => {
  const rest = { smile: 0.08, jaw: 0.02 };
  const laugh = { smile: 0.72, jaw: 0.1 };
  const burst = series([[0, rest], [800, laugh], [1500, rest], [2200, rest]]);
  assert.equal(count(createLaughDetector(), burst), 1);

  // Already smiling when tracking starts, and staying there.
  const resting = series([[0, { smile: 0.55, jaw: 0.04 }], [2500, { smile: 0.55, jaw: 0.04 }]]);
  assert.equal(count(createLaughDetector(), resting), 0, "resting smile");

  // A polite smile that creeps up stays under the rise and min-smile bars.
  const polite = series([[0, rest], [400, rest], [2000, { smile: 0.35, jaw: 0.04 }], [3000, { smile: 0.35, jaw: 0.04 }]]);
  assert.equal(count(createLaughDetector(), polite), 0, "slow polite smile");

  const zeros = [];
  for (let t = 0; t < 2500; t += 83) zeros.push({ t, face: true, pitch: 0, yaw: 0 });
  assert.equal(count(createLaughDetector(), zeros), 0);
  assert.equal(count(createBrowDetector(), zeros), 0);
  assert.equal(count(createWinkDetector(), zeros), 0);
  assert.equal(count(createTiltDetector(), zeros), 0);
});

test("talking with a grin is not a laugh, and a laugh re-arms after the smile drops", () => {
  const rest = { smile: 0.08, jaw: 0.02 };
  const talkPts = [[0, rest], [600, rest]];
  for (let t = 600, i = 0; t <= 1600; t += 83, i++) {
    talkPts.push([t, { smile: 0.7, jaw: i % 2 === 0 ? 0.4 : 0.04 }]);
  }
  talkPts.push([1700, rest], [2000, rest]);
  assert.equal(count(createLaughDetector(), series(talkPts)), 0, "talking");

  const two = series([
    [0, rest],
    [600, { smile: 0.75, jaw: 0.1 }], [1300, rest],
    [4000, { smile: 0.75, jaw: 0.1 }], [4700, rest], [5000, rest],
  ]);
  assert.equal(count(createLaughDetector(), two), 2);
});
