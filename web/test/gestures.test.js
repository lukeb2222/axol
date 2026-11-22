// The nod and tongue detectors, run over readings taken from real video clips (see the fixture's
// "about" line) and over hand-made traces for the cases the clips do not cover.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createNodDetector, createTongueDetector, headAngles, SENSITIVITY } from "../src/lib/gestures.js";

const { clips } = JSON.parse(fs.readFileSync(new URL("./fixtures/gestures.json", import.meta.url), "utf8"));
const readings = (name) => clips[name].map(([t, pitch, yaw, jaw, run]) => ({ t, pitch, yaw, jaw, run, face: true }));
const count = (detector, list) => list.filter((r) => detector.push(r)).length;
// A hand-made pitch trace: [[ms, degrees], …] joined by straight lines, sampled 12 times a second.
function trace(points) {
  const out = [];
  for (let t = points[0][0]; t <= points.at(-1)[0]; t += 83) {
    const i = Math.max(1, points.findIndex((p) => p[0] >= t)), [t0, a] = points[i - 1], [t1, b] = points[i];
    out.push({ t, pitch: a + ((b - a) * (t - t0)) / (t1 - t0 || 1), yaw: 0, face: true });
  }
  return out;
}

test("pitch is positive when the head tips down, negative when it tips up", () => {
  const face = (deg) => { const r = (deg * Math.PI) / 180; return [1, 0, 0, 0, 0, Math.cos(r), Math.sin(r), 0, 0, -Math.sin(r), Math.cos(r), 0, 0, 0, 0, 1]; };
  assert.ok(Math.abs(headAngles(face(15)).pitch - 15) < 1e-6);
  assert.ok(Math.abs(headAngles(face(-20)).pitch + 20) < 1e-6);
  assert.ok(Math.abs(headAngles(face(0)).yaw) < 1e-6);
});

test("a nod reads the same when the camera picture is sideways or upside down", () => {
  // The head tipped down 15 degrees, then the whole picture turned by `roll` degrees.
  const tipped = (roll) => {
    const p = (15 * Math.PI) / 180, r = (roll * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    const cols = [[1, 0, 0], [0, Math.cos(p), Math.sin(p)], [0, -Math.sin(p), Math.cos(p)]].map(([x, y, z]) => [c * x - s * y, s * x + c * y, z]);
    return [...cols[0], 0, ...cols[1], 0, ...cols[2], 0, 0, 0, 0, 1];
  };
  for (const roll of [0, 20, 90, 180, 270]) {
    const a = headAngles(tipped(roll));
    assert.ok(Math.abs(a.pitch - 15) < 1e-6, `pitch at roll ${roll}: ${a.pitch}`);
    assert.ok(Math.abs(a.yaw) < 1e-6, `yaw at roll ${roll}: ${a.yaw}`);
  }
});

test("nods are counted in a real clip of someone nodding", () => {
  const n = count(createNodDetector(SENSITIVITY.normal.nod), readings("head_nodding"));
  assert.ok(n >= 4 && n <= 10, `expected several nods in 9 seconds, got ${n}`);
});

test("sitting still and shaking the head are not nods, at any sensitivity", () => {
  for (const level of Object.values(SENSITIVITY)) {
    assert.equal(count(createNodDetector(level.nod), readings("head_stationary")), 0);
    assert.equal(count(createNodDetector(level.nod), readings("head_turning")), 0);
  }
});

test("one nod is one scroll; looking down and staying there is none", () => {
  const rest = [[0, 2], [1500, 2]];
  assert.equal(count(createNodDetector(), trace([...rest, [1800, 18], [2100, 2], [4000, 2]])), 1, "down and back");
  assert.equal(count(createNodDetector(), trace([...rest, [1800, 22], [6000, 22], [6400, 2], [8000, 2]])), 0, "looked down at something, then back up later");
  assert.equal(count(createNodDetector(), trace([...rest, [1800, -16], [2100, 2], [4000, 2]])), 0, "tipping the head up and back");
  assert.equal(count(createNodDetector(), trace([...rest, [9000, 20], [12000, 20]])), 0, "slowly slumping");
  assert.equal(count(createNodDetector(), trace([...rest, [1800, 7], [2100, 2], [4000, 2]])), 0, "a small bob is under the normal threshold");
  assert.equal(count(createNodDetector(SENSITIVITY.high.nod), trace([...rest, [1800, 9.5], [2100, 2], [4000, 2]])), 1, "the sensitive setting accepts a smaller nod");
  assert.equal(count(createNodDetector(SENSITIVITY.normal.nod), trace([...rest, [1800, 9.5], [2100, 2], [4000, 2]])), 0, "which the normal setting ignores");
  assert.equal(count(createNodDetector(SENSITIVITY.low.nod), trace([...rest, [1800, 13], [2100, 2], [4000, 2]])), 0, "the less sensitive setting needs a bigger one");
});

test("nodding still works after settling into a new posture", () => {
  const list = trace([[0, 0], [1000, 0], [1400, 20], [9000, 20], [9300, 36], [9600, 20], [11000, 20]]);
  assert.equal(count(createNodDetector(), list), 1);
});

test("a camera that comes on in the middle of a movement finds the resting position quickly", () => {
  // Tracking starts with the head already tipped 14 degrees down; it comes back up, then nods twice.
  const list = trace([[0, 14], [300, 0], [1800, 0], [2100, 15], [2400, 0], [3500, 0], [3800, 15], [4100, 0], [5000, 0]]);
  assert.equal(count(createNodDetector(), list), 2);
});

test("a turned-away head and a lost face do not count", () => {
  const turned = trace([[0, 0], [1500, 0], [1800, 18], [2100, 0], [3000, 0]]).map((r) => ({ ...r, yaw: 45 }));
  assert.equal(count(createNodDetector(), turned), 0);
  const d = createNodDetector();
  const list = trace([[0, 0], [1500, 0], [1800, 18], [2100, 0], [3000, 0]]).map((r) => (r.t > 1600 && r.t < 2000 ? { ...r, face: false } : r));
  assert.equal(count(d, list), 0);
});

test("the tongue clip scrolls once, when the tongue comes out and not while smiling", () => {
  const d = createTongueDetector(SENSITIVITY.normal.tongue);
  const fired = readings("tongue").filter((r) => d.push(r)).map((r) => r.t);
  assert.equal(fired.length, 1);
  assert.ok(fired[0] > 800, `the first 0.8 seconds are a smile; fired at ${fired[0]} ms`);
});

test("laughing, talking and sitting still never read as a tongue, at any sensitivity", () => {
  for (const level of Object.values(SENSITIVITY)) {
    for (const clip of ["head_nodding", "head_stationary", "head_turning"]) {
      assert.equal(count(createTongueDetector(level.tongue), readings(clip)), 0, clip);
    }
  }
});

test("tongue out fires once however long it is held, and again after it goes back in", () => {
  const d = createTongueDetector();
  const at = (t, out) => ({ t, face: true, jaw: out ? 0.4 : 0.02, run: out ? 13 : 4 });
  const list = [];
  for (let t = 0; t < 1000; t += 83) list.push(at(t, false));
  for (let t = 1000; t < 3000; t += 83) list.push(at(t, true));
  for (let t = 3000; t < 4000; t += 83) list.push(at(t, false));
  for (let t = 4000; t < 4600; t += 83) list.push(at(t, true));
  assert.equal(count(d, list), 2);
  // A single stray reading is not enough.
  const blip = createTongueDetector();
  assert.equal(count(blip, [at(0, false), at(83, false), at(166, true), at(249, false), at(332, false)]), 0);
});

test("a face that reads pink with the mouth shut cannot set tongue scrolling off by opening the mouth", () => {
  const d = createTongueDetector();
  const list = [];
  for (let t = 0; t < 3000; t += 83) list.push({ t, face: true, jaw: 0.01, run: 12 });
  for (let t = 3000; t < 4000; t += 83) list.push({ t, face: true, jaw: 0.3, run: 13 });
  assert.equal(count(d, list), 0);
});
