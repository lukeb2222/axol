// Guided calibration of the tongue-out reading. Pure logic: push camera readings, get a step.
import { tongueNeed } from "./gestures.js";

const median = (arr) => {
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
};

/**
 * Walks a person through "mouth closed" then "tongue out" and, if the two readings are clearly
 * different, returns { rest, out, need } to store in settings.
 */
export function createTongueCalibrator({
  closedMs = 2000,
  outMs = 1200,
  minGap = 3,
  closedJaw = 0.08,
  outJaw = 0.12,
  minClosed = 8,
  minOut = 6,
} = {}) {
  let step = "closed"; // closed | out | done | fail
  let closedSince = null, outSince = null;
  const closedSamples = [], outSamples = [];
  let result = null;

  const status = (t) => {
    let progress = 0;
    if (step === "closed") progress = closedSince != null && t != null ? Math.min(1, (t - closedSince) / closedMs) : 0;
    if (step === "out") progress = outSince != null && t != null ? Math.min(1, (t - outSince) / outMs) : 0;
    if (step === "done" || step === "fail") progress = 1;
    return { step, progress, result };
  };

  return {
    reset() {
      step = "closed"; closedSince = null; outSince = null;
      closedSamples.length = 0; outSamples.length = 0; result = null;
    },
    push({ t, face, jaw = 0, run = 0 }) {
      if (step === "done" || step === "fail") return status(t);
      if (!face) { closedSince = null; outSince = null; return status(t); }
      if (step === "closed") {
        if (jaw < closedJaw) {
          closedSince ??= t;
          closedSamples.push(run);
          if (t - closedSince >= closedMs && closedSamples.length >= minClosed) {
            step = "out";
            outSince = null;
          }
        } else {
          closedSince = null;
        }
      } else if (step === "out") {
        if (jaw >= outJaw) {
          outSince ??= t;
          outSamples.push(run);
          if (t - outSince >= outMs && outSamples.length >= minOut) {
            const rest = median(closedSamples);
            const out = median(outSamples);
            if (out - rest >= minGap) {
              step = "done";
              result = { rest, out, need: tongueNeed({ calib: { rest, out } }) };
            } else {
              step = "fail";
              result = { rest, out, reason: "too-close" };
            }
          }
        } else {
          outSince = null;
        }
      }
      return status(t);
    },
    status,
  };
}
