// Preferences kept on this device. Components subscribe so a toggle on one screen takes effect on another.
const KEY = "axol_settings";
const DEFAULTS = { nod: false, tongue: false, sensitivity: "normal", handsFreePaused: false };

let current = (() => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { return { ...DEFAULTS }; } })();
const listeners = new Set();

export const getSettings = () => current;
export function setSettings(patch) {
  current = { ...current, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch {}
  for (const fn of listeners) fn(current);
}
export function subscribeSettings(fn) { listeners.add(fn); return () => listeners.delete(fn); }
