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
 * push(reading) returns true at the moment it counts.
 */
export function createTongueDetector({ minRun = 11, minJaw = 0.12, holdMs = 160, rearmMs = 250, cooldownMs = 900, rows = 14 } = {}) {
  let since = null, fired = false, offSince = null, lastFire = -Infinity, rest = null;
  return {
    reset() { since = null; fired = false; offSince = null; },
    push({ t, run = 0, jaw = 0, face = true }) {
      if (!face) { since = null; return false; }
      // What this face looks like with the mouth shut: some faces read pink there anyway, and
      // for them the bar is raised (past the top of the scale if need be, so it never misfires).
      if (jaw < 0.05) rest = rest === null ? run : rest + (run - rest) * 0.1;
      const need = Math.max(minRun, rest === null ? 0 : Math.round(rest) + 3);
      const out = jaw >= minJaw && run >= need && need <= rows;
      if (!out) {
        since = null;
        if (fired) { offSince ??= t; if (t - offSince >= rearmMs) { fired = false; offSince = null; } }
        return false;
      }
      offSince = null;
      since ??= t;
      if (!fired && t - since >= holdMs && t - lastFire >= cooldownMs) { fired = true; lastFire = t; return true; }
      return false;
    },
  };
}
