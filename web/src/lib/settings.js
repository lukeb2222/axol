// Preferences kept on this device. Components subscribe so a toggle on one screen takes effect on another.
const KEY = "axol_settings";
const DEFAULTS = { nod: false, tongue: false, sensitivity: "normal", handsFreePaused: false, cameraId: "", tongueCalib: null, tongueHold: "normal" };

function load() {
  try {
    const raw = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
    if (raw.tongueHold !== "quick" && raw.tongueHold !== "steady") raw.tongueHold = "normal";
    const c = raw.tongueCalib;
    if (!c || !Number.isFinite(c.rest) || !Number.isFinite(c.out) || c.out - c.rest < 3) raw.tongueCalib = null;
    else raw.tongueCalib = { rest: c.rest, out: c.out };
    return raw;
  } catch { return { ...DEFAULTS }; }
}

let current = load();
const listeners = new Set();

export const getSettings = () => current;
export function setSettings(patch) {
  current = { ...current, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch {}
  for (const fn of listeners) fn(current);
}
export function subscribeSettings(fn) { listeners.add(fn); return () => listeners.delete(fn); }
