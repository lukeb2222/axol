// Turning head-tracker readings into gestures. Pure logic: no camera, no browser APIs.
//
// Readings arrive about 12 times a second: the time, whether a face is in view, the head's pitch
// and yaw in degrees (pitch grows as the head tips down), and, when tongue scrolling is on, how
// open the jaw is and how many rows of the mouth strip look like tongue (see tongue.js).

/**
 * Degrees of pitch (down is positive) and yaw from the tracker's 4×4 face matrix (column-major).
 * Measured against the head's own up direction as it appears in the picture, so the answer is the
 * same whether the camera picture is upright, sideways or upside down.
 */
export function headAngles(m) {
  const deg = 180 / Math.PI;
  const up = [m[4], m[5]], fwd = [m[8], m[9], m[10]]; // second and third columns: the head's up and facing directions
  const len = Math.hypot(up[0], up[1]) || 1, ux = up[0] / len, uy = up[1] / len;
  return {
    pitch: Math.atan2(-(fwd[0] * ux + fwd[1] * uy), fwd[2]) * deg,
    yaw: Math.atan2(fwd[0] * uy - fwd[1] * ux, fwd[2]) * deg,
    // Tilt of the head in the picture (after it has been turned upright). Left and right are signed.
    roll: Math.atan2(m[4], m[5]) * deg,
  };
}

/** Scores we care about from a MediaPipe blendshape list. Missing names are 0. */
export function blendScores(categories) {
  const get = (name) => {
    const hit = categories?.find((c) => c.categoryName === name);
    return hit ? hit.score : 0;
  };
  return {
    jaw: get("jawOpen"),
    blinkL: get("eyeBlinkLeft"),
    blinkR: get("eyeBlinkRight"),
    brow: get("browInnerUp"),
    smile: (get("mouthSmileLeft") + get("mouthSmileRight")) / 2,
  };
}

function follow(cur, next, dt, tau) {
  return cur + (next - cur) * (1 - Math.exp(-dt / Math.max(1, tau)));
}

function jawTalking(hist, t, jaw, minJaw = 0.12) {
  hist.push({ t, jaw });
  while (hist.length && t - hist[0].t > 500) hist.shift();
  if (hist.length < 3) return false;
  let crossings = 0;
  for (let i = 1; i < hist.length; i++) {
    if ((hist[i - 1].jaw >= minJaw) !== (hist[i].jaw >= minJaw)) crossings += 1;
  }
  return crossings >= 2;
}

export const SENSITIVITY = {
  // small movements count
  high: {
    nod: { down: 6 }, tongue: { minRun: 10 }, margin: 0,
    wink: { closed: 0.5, open: 0.38, spread: 0.28, holdMs: 140 },
    tilt: { deg: 14 },
    brow: { rise: 0.22, holdMs: 220 },
    laugh: { minSmile: 0.4, rise: 0.16, holdMs: 350 },
  },
  normal: {
    nod: { down: 8 }, tongue: { minRun: 11 }, margin: 0.005,
    wink: { closed: 0.55, open: 0.35, spread: 0.32, holdMs: 180 },
    tilt: { deg: 18 },
    brow: { rise: 0.28, holdMs: 280 },
    laugh: { minSmile: 0.45, rise: 0.2, holdMs: 450 },
  },
  // only big, deliberate ones
  low: {
    nod: { down: 12 }, tongue: { minRun: 12 }, margin: 0.01,
    wink: { closed: 0.62, open: 0.3, spread: 0.38, holdMs: 240 },
    tilt: { deg: 24 },
    brow: { rise: 0.35, holdMs: 360 },
    laugh: { minSmile: 0.55, rise: 0.28, holdMs: 600 },
  },
};

// How long the tongue must stay out before it counts as a scroll.
export const TONGUE_HOLD = { quick: 110, normal: 160, steady: 280 };

/**
 * How many pink rows are needed to count as a tongue. With no calibration this is at least
 * `minRun`, and is raised if this face already looks pink with the mouth shut. After a
 * calibration it sits halfway between the person's rest and their tongue-out reading, so a
 * shorter tongue still works when it is clearly different from rest.
 */
export function tongueNeed({ minRun = 11, rows = 14, rest = null, calib = null } = {}) {
  let need = minRun;
  if (calib && Number.isFinite(calib.rest) && Number.isFinite(calib.out) && calib.out - calib.rest >= 3) {
    need = Math.round(calib.rest + Math.max(3, (calib.out - calib.rest) * 0.5));
    need = Math.max(need, Math.round(calib.rest) + 3, 6);
  } else if (rest != null) {
    need = Math.max(minRun, Math.round(rest) + 3);
  }
  return Math.min(need, rows);
}

/**
 * A nod: the head tips down by at least `down` degrees from where it has been resting and comes
 * back within `maxMs`. Looking down and staying there (at a keyboard, a phone, a plate) is not a
 * nod; neither is turning the head, tipping it up, or a slow change of posture.
 * push(reading) returns true at the moment a nod completes.
 */
export function createNodDetector({ down = 8, back = 4, maxMs = 1200, cooldownMs = 500, maxYaw = 30, settleMs = 1000 } = {}) {
  let base = null, state = "idle", t0 = 0, last = 0, lastFire = -Infinity, since = 0;
  const follow = (pitch, dt, tau) => { base += (pitch - base) * (1 - Math.exp(-dt / tau)); };
  return {
    reset() { base = null; state = "idle"; },
    push({ t, pitch, yaw = 0, face = true }) {
      if (!face) { if (t - last > 1500) base = null; state = "idle"; return false; }
      const dt = t - last; last = t;
      if (base === null || dt > 1500) { base = pitch; since = t; state = "idle"; return false; }
      // For the first second the resting position is still being found (the camera may have
      // come on mid-movement), so it is followed closely and nothing counts yet.
      if (t - since < settleMs) { follow(pitch, dt, 350); return false; }
      const d = pitch - base;
      if (state === "idle") {
        if (d >= down && Math.abs(yaw) <= maxYaw && t - lastFire >= cooldownMs) { state = "down"; t0 = t; return false; }
        // The resting position is followed quickly when the head is near it and slowly when it is
        // away, so a new posture is adopted within a few seconds but a nod does not drag it along.
        follow(pitch, dt, Math.abs(d) < down * 0.6 ? 1500 : 3500);
        return false;
      }
      if (state === "down") {
        if (d <= back) { state = "idle"; if (t - t0 <= maxMs) { lastFire = t; return true; } return false; }
        if (t - t0 > maxMs) state = "held";
        return false;
      }
      // held: they are looking down, not nodding. Settle on the new position, then start over.
      follow(pitch, dt, 1200);
      if (Math.abs(pitch - base) <= back) state = "idle";
      return false;
    },
  };
}

/**
 * Tongue out: the jaw is open and a long stretch below the upper lip looks like tongue, steadily
 * for `holdMs`. Fires once per stick-out. A mouth that is merely open (talking, laughing, yawning)
 * shows teeth and the dark inside of the mouth, which break the stretch.
 *
 * Readings are smoothed with a short, time-based average so a single noisy frame cannot trip it,
 * and leaving "out" is slightly easier than entering (hysteresis) so it does not flicker at the
 * threshold. Rapid open/close of the jaw (talking) is ignored. `calib: { rest, out }` from a
 * guided calibration replaces the automatic rest estimate.
 * push(reading) returns true at the moment it counts.
 */
export function createTongueDetector({
  minRun = 11, minJaw = 0.12, holdMs = 160, rearmMs = 250, cooldownMs = 900, rows = 14,
  smoothMs = 70, offSlack = 2, jawOff = 0.08, calib = null,
} = {}) {
  let since = null, fired = false, offSince = null, lastFire = -Infinity, rest = calib?.rest ?? null;
  let last = 0, sRun = null, sJaw = null;
  const hist = [];
  const follow = (cur, next, dt, tau) => cur + (next - cur) * (1 - Math.exp(-dt / Math.max(1, tau)));
  const isTalking = (t, jaw) => {
    hist.push({ t, jaw });
    while (hist.length && t - hist[0].t > 500) hist.shift();
    if (hist.length < 3) return false;
    let crossings = 0;
    for (let i = 1; i < hist.length; i++) {
      if ((hist[i - 1].jaw >= minJaw) !== (hist[i].jaw >= minJaw)) crossings += 1;
    }
    return crossings >= 2;
  };
  return {
    reset() { since = null; fired = false; offSince = null; sRun = null; sJaw = null; hist.length = 0; if (!calib) rest = null; },
    need() { return tongueNeed({ minRun, rows, rest, calib }); },
    push({ t, run = 0, jaw = 0, face = true }) {
      if (!face) { since = null; sRun = null; sJaw = null; return false; }
      const dt = last ? Math.max(0, Math.min(200, t - last)) : 80;
      last = t;
      sRun = sRun == null ? run : follow(sRun, run, dt, smoothMs);
      sJaw = sJaw == null ? jaw : follow(sJaw, jaw, dt, 50);
      // What this face looks like with the mouth shut: some faces read pink there anyway, and
      // for them the bar is raised (past the top of the scale if need be, so it never misfires).
      if (!calib && sJaw < 0.05) rest = rest === null ? run : follow(rest, run, dt, 400);
      const need = tongueNeed({ minRun, rows, rest, calib });
      const talking = isTalking(t, jaw);
      const on = sJaw >= minJaw && sRun >= need && need <= rows && !talking;
      const still = sJaw >= jawOff && sRun >= Math.max(0, need - offSlack);
      if (!still) {
        since = null;
        if (fired) { offSince ??= t; if (t - offSince >= rearmMs) { fired = false; offSince = null; } }
        return false;
      }
      if (!on && !fired) { since = null; return false; }
      offSince = null;
      since ??= t;
      if (!fired && on && t - since >= holdMs && t - lastFire >= cooldownMs) { fired = true; lastFire = t; return true; }
      return false;
    },
  };
}


/**
 * A wink: one eye is clearly closed, the other stays open, steadily for `holdMs`. A normal blink
 * closes both eyes (even if one leads by a frame) and is ignored. Fires once per wink; re-arms
 * after both eyes are open again.
 * push(reading) returns true at the moment it counts.
 */
export function createWinkDetector({
  closed = 0.55, open = 0.35, spread = 0.32, holdMs = 180, cooldownMs = 900, rearmMs = 160, smoothMs = 50,
} = {}) {
  let since = null, fired = false, offSince = null, lastFire = -Infinity, last = 0, sL = null, sR = null;
  return {
    reset() { since = null; fired = false; offSince = null; sL = null; sR = null; },
    push({ t, blinkL = 0, blinkR = 0, face = true }) {
      if (!face) { since = null; sL = null; sR = null; return false; }
      const dt = last ? Math.max(0, Math.min(200, t - last)) : 80;
      last = t;
      sL = sL == null ? blinkL : follow(sL, blinkL, dt, smoothMs);
      sR = sR == null ? blinkR : follow(sR, blinkR, dt, smoothMs);
      // Both eyes closing together is a blink, even if one is slightly ahead.
      const both = sL >= 0.4 && sR >= 0.4;
      const left = sL >= closed && sR <= open && (sL - sR) >= spread;
      const right = sR >= closed && sL <= open && (sR - sL) >= spread;
      const on = !both && (left || right);
      if (both || !on) {
        since = null;
        if (fired) {
          const openEnough = Math.max(sL, sR) <= open;
          if (openEnough) { offSince ??= t; if (t - offSince >= rearmMs) { fired = false; offSince = null; } }
          else offSince = null;
        }
        return false;
      }
      offSince = null;
      since ??= t;
      if (!fired && t - since >= holdMs && t - lastFire >= cooldownMs) { fired = true; lastFire = t; return true; }
      return false;
    },
  };
}

/**
 * A head tilt: the head tips to one side by at least `deg` from its rest and comes back within
 * `maxMs`. Holding the head tilted (or a phone that is still settling upright) is not a tilt;
 * neither is a nod, a turn, or a slow change of posture. Either side counts as "go back".
 * push(reading) returns true at the moment a tilt completes.
 */
export function createTiltDetector({
  deg = 18, back = 8, maxMs = 1200, cooldownMs = 600, maxPitch = 25, maxYaw = 25, maxRoll = 50, settleMs = 1000,
} = {}) {
  let base = null, state = "idle", t0 = 0, last = 0, lastFire = -Infinity, since = 0, side = 0;
  const track = (roll, dt, tau) => { base += (roll - base) * (1 - Math.exp(-dt / tau)); };
  return {
    reset() { base = null; state = "idle"; side = 0; },
    push({ t, roll = 0, pitch = 0, yaw = 0, face = true }) {
      if (!face) { if (t - last > 1500) base = null; state = "idle"; return false; }
      const dt = t - last; last = t;
      if (base === null || dt > 1500) { base = roll; since = t; state = "idle"; return false; }
      if (t - since < settleMs) { track(roll, dt, 350); return false; }
      // A nearly sideways face is the camera picture itself turning, not a gesture.
      if (Math.abs(roll) > maxRoll) { state = "idle"; track(roll, dt, 400); return false; }
      const d = roll - base;
      if (state === "idle") {
        const ready = t - lastFire >= cooldownMs && Math.abs(pitch) <= maxPitch && Math.abs(yaw) <= maxYaw;
        if (Math.abs(d) >= deg && ready) { state = "out"; t0 = t; side = Math.sign(d); return false; }
        track(roll, dt, Math.abs(d) < deg * 0.6 ? 1500 : 3500);
        return false;
      }
      if (state === "out") {
        // Must come back toward rest on the same side of the movement; crossing through rest counts.
        if (side * (roll - base) <= back) { state = "idle"; if (t - t0 <= maxMs) { lastFire = t; return true; } return false; }
        if (t - t0 > maxMs) state = "held";
        return false;
      }
      track(roll, dt, 1200);
      if (Math.abs(roll - base) <= back) state = "idle";
      return false;
    },
  };
}

/**
 * Raised eyebrows: the brows lift by at least `rise` above a resting baseline and stay there for
 * `holdMs`. Talking (a jaw that opens and closes quickly) is ignored, as is a one-frame flash.
 * Fires once per raise; re-arms after the brows come back down.
 * push(reading) returns true at the moment it counts.
 */
export function createBrowDetector({
  rise = 0.28, holdMs = 280, cooldownMs = 1200, rearmMs = 200, smoothMs = 70, jawTalk = 0.12,
} = {}) {
  let since = null, fired = false, offSince = null, lastFire = -Infinity, last = 0, sBrow = null, rest = null;
  const hist = [];
  return {
    reset() { since = null; fired = false; offSince = null; sBrow = null; rest = null; hist.length = 0; },
    push({ t, brow = 0, jaw = 0, face = true }) {
      if (!face) { since = null; sBrow = null; return false; }
      const dt = last ? Math.max(0, Math.min(200, t - last)) : 80;
      last = t;
      sBrow = sBrow == null ? brow : follow(sBrow, brow, dt, smoothMs);
      const talking = jawTalking(hist, t, jaw, jawTalk);
      if (sBrow < (rest ?? 0) + rise * 0.45) rest = rest == null ? sBrow : follow(rest, sBrow, dt, 700);
      const lift = sBrow - (rest ?? 0);
      const on = lift >= rise && !talking;
      const still = lift >= rise * 0.7;
      if (!still) {
        since = null;
        if (fired) { offSince ??= t; if (t - offSince >= rearmMs) { fired = false; offSince = null; } }
        return false;
      }
      if (!on && !fired) { since = null; return false; }
      offSince = null;
      since ??= t;
      if (!fired && on && t - since >= holdMs && t - lastFire >= cooldownMs) { fired = true; lastFire = t; return true; }
      return false;
    },
  };
}

/**
 * A laugh: the smile rises quickly from a personal rest and stays clearly up for `holdMs`. A
 * resting or slowly growing polite smile is not a laugh, and neither is talking with a slight
 * grin. Fires once per burst; re-arms after the smile comes back down.
 * push(reading) returns true at the moment it counts.
 */
export function createLaughDetector({
  minSmile = 0.45, rise = 0.2, holdMs = 450, cooldownMs = 2500, smoothMs = 80, mid = 0.28, jawTalk = 0.12,
} = {}) {
  let since = null, fired = false, lastFire = -Infinity, last = 0, sSmile = null, rest = null;
  const hist = [];
  return {
    reset() { since = null; fired = false; sSmile = null; rest = null; hist.length = 0; },
    push({ t, smile = 0, jaw = 0, face = true }) {
      if (!face) { since = null; sSmile = null; return false; }
      const dt = last ? Math.max(0, Math.min(200, t - last)) : 80;
      last = t;
      sSmile = sSmile == null ? smile : follow(sSmile, smile, dt, smoothMs);
      const talking = jawTalking(hist, t, jaw, jawTalk);
      // Only follow rest while the mouth is not already smiling, so a long grin does not drag the
      // baseline up and a sudden laugh still stands out from it.
      if (sSmile < mid) rest = rest == null ? sSmile : follow(rest, sSmile, dt, 800);
      else if (rest == null) rest = sSmile; // already smiling when we started: treat that as rest, not a laugh
      const lift = sSmile - (rest ?? 0);
      const on = sSmile >= minSmile && lift >= rise && !talking;
      const still = sSmile >= minSmile - 0.08 && lift >= rise * 0.65;
      if (!still) {
        since = null;
        if (fired && sSmile < mid) fired = false;
        return false;
      }
      if (!on && !fired) { since = null; return false; }
      since ??= t;
      if (!fired && on && t - since >= holdMs && t - lastFire >= cooldownMs) { fired = true; lastFire = t; return true; }
      return false;
    },
  };
}
