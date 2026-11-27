// Tongue colour measure, calibration, hold thresholds and the undo window — all pure functions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tongueFeatures } from "../src/lib/tongue.js";
import { createTongueDetector, tongueNeed, TONGUE_HOLD, SENSITIVITY } from "../src/lib/gestures.js";
import { createTongueCalibrator } from "../src/lib/tongueCalib.js";
import { rememberUndo, undoTarget, UNDO_MS } from "../src/lib/handsFreeUndo.js";

function face({ open = 0.03 } = {}) {
  const lm = Array.from({ length: 300 }, () => ({ x: 0.5, y: 0.5 }));
  lm[10] = { x: 0.5, y: 0.15 };           // forehead
  lm[13] = { x: 0.5, y: 0.45 };           // upper lip
  lm[14] = { x: 0.5, y: 0.45 + open };    // inner lower lip
  lm[152] = { x: 0.5, y: 0.75 };          // chin
  lm[61] = { x: 0.4, y: 0.5 };
  lm[291] = { x: 0.6, y: 0.5 };
  lm[50] = { x: 0.3, y: 0.45 };
  lm[280] = { x: 0.7, y: 0.45 };
  return lm;
}

const SKIN = [180, 120, 80], TONGUE = [200, 70, 90], TEETH = [230, 230, 230], DARK = [18, 14, 14];

// The strip runs from the upper lip (y≈0.45) toward the chin (y≈0.69). `kind` chooses what
// that column looks like: shut (skin/teeth), out (tongue from the lips down), or a pink chin only.
function pxFor(kind) {
  return (x, y) => {
    if (x < 0.36 || x > 0.64) return SKIN;
    if (kind === "out") return y >= 0.44 && y <= 0.7 ? TONGUE : SKIN;
    if (kind === "chin") return y >= 0.6 ? TONGUE : SKIN;
    if (kind === "smile") return y >= 0.44 && y < 0.5 ? TONGUE : y < 0.55 ? TEETH : SKIN;
    if (kind === "open") return y >= 0.44 && y < 0.5 ? TONGUE : y < 0.62 ? DARK : SKIN;
    return SKIN;
  };
}

test("a stuck-out tongue fills most of the strip; a closed or smiling mouth does not", () => {
  const lmShut = face({ open: 0.02 }), lmOpen = face({ open: 0.16 });
  const out = tongueFeatures(pxFor("out"), lmOpen);
  const shut = tongueFeatures(pxFor("shut"), lmShut);
  const smile = tongueFeatures(pxFor("smile"), lmShut);
  const open = tongueFeatures(pxFor("open"), lmOpen);
  assert.ok(out.run >= 10, `tongue out run ${out.run}`);
  assert.ok(shut.run <= 3, `closed run ${shut.run}`);
  assert.ok(smile.run <= 5, `smile run ${smile.run}`);
  assert.ok(open.run <= 5, `open-mouth run ${open.run}`);
  assert.ok(out.open > shut.open);
});

test("a pink patch on the chin alone is not a tongue", () => {
  const lm = face({ open: 0.16 });
  const chin = tongueFeatures(pxFor("chin"), lm);
  const out = tongueFeatures(pxFor("out"), lm);
  assert.ok(chin.run <= 3, `chin-only fromLip ${chin.run}, anywhere ${chin.anywhere}`);
  assert.ok(chin.anywhere >= 5, "the old anywhere-in-the-strip count would still see it");
  assert.ok(out.run >= 10);
});

test("tongueNeed sits halfway between a calibration's rest and tongue-out readings", () => {
  assert.equal(tongueNeed({ minRun: 11 }), 11);
  assert.equal(tongueNeed({ minRun: 11, rest: 8 }), 11); // rest+3 is 11
  assert.equal(tongueNeed({ minRun: 11, rest: 10 }), 13);
  const need = tongueNeed({ calib: { rest: 3, out: 9 } });
  assert.equal(need, 6); // rest + max(3, 3) = 6, and this may be below the uncalibrated minRun
  assert.equal(tongueNeed({ calib: { rest: 4, out: 14 } }), 9);
  assert.equal(tongueNeed({ calib: { rest: 12, out: 13 } }), 11); // gap too small: ignored
});

test("a calibrated shorter tongue still scrolls; the same reading is ignored without calibration", () => {
  const at = (t, out) => ({ t, face: true, jaw: out ? 0.4 : 0.02, run: out ? 8 : 3 });
  const series = (d) => {
    const list = [];
    for (let t = 0; t < 1000; t += 83) list.push(at(t, false));
    for (let t = 1000; t < 2000; t += 83) list.push(at(t, true));
    return list.filter((r) => d.push(r)).length;
  };
  assert.equal(series(createTongueDetector()), 0, "8 rows is under the default bar of 11");
  assert.equal(series(createTongueDetector({ calib: { rest: 3, out: 9 } })), 1, "calibration lowers the bar to 6");
});

test("rapid open-and-close of the jaw (talking) does not count as a tongue", () => {
  const d = createTongueDetector();
  const list = [];
  for (let t = 0; t < 900; t += 83) list.push({ t, face: true, jaw: 0.02, run: 4 });
  for (let t = 900; t < 2800; t += 83) {
    const open = Math.floor((t - 900) / 160) % 2 === 0;
    list.push({ t, face: true, jaw: open ? 0.35 : 0.04, run: open ? 13 : 4 });
  }
  assert.equal(list.filter((r) => d.push(r)).length, 0);
});

test("a flicker around the threshold does not fire a second time", () => {
  const d = createTongueDetector();
  const list = [];
  for (let t = 0; t < 800; t += 83) list.push({ t, face: true, jaw: 0.02, run: 4 });
  for (let t = 800; t < 1600; t += 83) list.push({ t, face: true, jaw: 0.4, run: 13 });
  // Dip just under the bar for a frame, then back: hysteresis should keep this as the same stick-out.
  list.push({ t: 1683, face: true, jaw: 0.4, run: 10 });
  for (let t = 1766; t < 2200; t += 83) list.push({ t, face: true, jaw: 0.4, run: 13 });
  assert.equal(list.filter((r) => d.push(r)).length, 1);
});

test("quick hold fires sooner than a steady one", () => {
  const run = (holdMs) => {
    const d = createTongueDetector({ holdMs });
    const fired = [];
    for (let t = 0; t < 700; t += 50) d.push({ t, face: true, jaw: 0.02, run: 4 });
    for (let t = 700; t < 1600; t += 50) if (d.push({ t, face: true, jaw: 0.4, run: 13 })) fired.push(t);
    return fired[0];
  };
  const quick = run(TONGUE_HOLD.quick), steady = run(TONGUE_HOLD.steady);
  assert.ok(quick < steady, `quick ${quick} should be earlier than steady ${steady}`);
  assert.ok(quick >= 700 + TONGUE_HOLD.quick - 50);
});

test("calibration records rest then tongue-out, and fails when they are too similar", () => {
  const ok = createTongueCalibrator({ closedMs: 400, outMs: 300, minClosed: 3, minOut: 3 });
  for (let t = 0; t < 500; t += 80) {
    const s = ok.push({ t, face: true, jaw: 0.02, run: 3 });
    if (t > 200) assert.equal(s.step, t >= 400 ? "out" : "closed");
  }
  let last;
  for (let t = 500; t < 900; t += 80) last = ok.push({ t, face: true, jaw: 0.4, run: 12 });
  assert.equal(last.step, "done");
  assert.equal(last.result.rest, 3);
  assert.equal(last.result.out, 12);
  assert.equal(last.result.need, tongueNeed({ calib: { rest: 3, out: 12 } }));

  const bad = createTongueCalibrator({ closedMs: 400, outMs: 300, minClosed: 3, minOut: 3 });
  for (let t = 0; t < 500; t += 80) bad.push({ t, face: true, jaw: 0.02, run: 10 });
  let fail;
  for (let t = 500; t < 900; t += 80) fail = bad.push({ t, face: true, jaw: 0.4, run: 11 });
  assert.equal(fail.step, "fail");
  assert.equal(fail.result.reason, "too-close");
});

test("calibration waits if the mouth opens during the closed step, or a face is lost", () => {
  const c = createTongueCalibrator({ closedMs: 400, outMs: 300, minClosed: 3, minOut: 3 });
  for (let t = 0; t < 240; t += 80) assert.equal(c.push({ t, face: true, jaw: 0.02, run: 3 }).step, "closed");
  assert.equal(c.push({ t: 240, face: true, jaw: 0.2, run: 3 }).progress, 0);
  for (let t = 320; t < 800; t += 80) {
    const s = c.push({ t, face: true, jaw: 0.02, run: 3 });
    if (t < 320 + 400) assert.equal(s.step, "closed");
  }
  const after = c.push({ t: 800, face: true, jaw: 0.02, run: 3 });
  assert.equal(after.step, "out");
  assert.equal(c.push({ t: 880, face: false, jaw: 0, run: 0 }).progress, 0);
});

test("undo remembers a real move for a short window and then expires", () => {
  assert.equal(rememberUndo(3, 3), null);
  const u = rememberUndo(3, 4, 1000);
  assert.equal(undoTarget(u, 1000), 3);
  assert.equal(undoTarget(u, 1000 + UNDO_MS - 1), 3);
  assert.equal(undoTarget(u, 1000 + UNDO_MS), null);
});

test("existing sensitivity presets still export a tongue minRun", () => {
  assert.ok(SENSITIVITY.normal.tongue.minRun >= 10);
  assert.ok(TONGUE_HOLD.quick < TONGUE_HOLD.normal && TONGUE_HOLD.normal < TONGUE_HOLD.steady);
});
