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
  };
}

export const SENSITIVITY = {
  high:   { nod: { down: 6 },  tongue: { minRun: 10 }, margin: 0 },      // small movements count
  normal: { nod: { down: 8 },  tongue: { minRun: 11 }, margin: 0.005 },
  low:    { nod: { down: 12 }, tongue: { minRun: 12 }, margin: 0.01 },   // only big, deliberate ones
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
