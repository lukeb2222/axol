// Preferences kept on this device. Components subscribe so a toggle on one screen takes effect on another.
const KEY = "axol_settings";
const DEFAULTS = {
  nod: false, tongue: false, sensitivity: "normal", handsFreePaused: false, cameraId: "",
  tongueCalib: null, tongueHold: "normal",
  winkLike: false, tiltBack: false, browPause: false, laughSave: false, gestureHud: false,
};
const FLAGS = ["nod", "tongue", "handsFreePaused", "winkLike", "tiltBack", "browPause", "laughSave", "gestureHud"];

function load() {
  try {
    const raw = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
    if (raw.tongueHold !== "quick" && raw.tongueHold !== "steady") raw.tongueHold = "normal";
    const c = raw.tongueCalib;
    if (!c || !Number.isFinite(c.rest) || !Number.isFinite(c.out) || c.out - c.rest < 3) raw.tongueCalib = null;
    else raw.tongueCalib = { rest: c.rest, out: c.out };
    for (const k of FLAGS) raw[k] = !!raw[k];
    if (raw.sensitivity !== "high" && raw.sensitivity !== "low") raw.sensitivity = "normal";
    raw.cameraId = typeof raw.cameraId === "string" ? raw.cameraId : "";
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

/** True when any camera-using hands-free feature is switched on (including the live HUD). */
export function wantsCamera(s = current) {
  return !!(s.nod || s.tongue || s.winkLike || s.tiltBack || s.browPause || s.laughSave || s.gestureHud);
}
