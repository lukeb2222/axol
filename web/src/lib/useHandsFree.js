import { useEffect, useRef, useState } from "react";
import { getSettings, setSettings, subscribeSettings } from "./settings.js";
import { createNodDetector, createTongueDetector, SENSITIVITY } from "./gestures.js";
import { startHeadTracker } from "./headTracker.js";

/**
 * Start the camera and turn its readings into gestures. `nod` / `tongue` choose what to look for.
 * Returns a function that stops everything.
 */
export function watchGestures({ nod, tongue, sensitivity, cameraId, onGesture, onStatus, onReading, onFrame }) {
  const level = SENSITIVITY[sensitivity] || SENSITIVITY.normal;
  const nods = nod ? createNodDetector(level.nod) : null;
  const tongues = tongue ? createTongueDetector(level.tongue) : null;
  return startHeadTracker({
    tongue, margin: level.margin, deviceId: cameraId, onStatus, onFrame,
    onReading: (r) => {
      onReading?.(r, level);
      if (window.__axolDebug) window.__axolDebug.push(r);
      if (nods?.push(r)) onGesture("nod");
      if (tongues?.push(r)) onGesture("tongue");
    },
  });
}

/**
 * Hands-free scrolling for the reel player. While it is switched on in settings and `active` is
 * true (the reels are on screen), the camera watches for a nod or a stuck-out tongue and calls
 * `onNext(kind)`. The camera is released whenever the reels are not showing.
 */
export function useHandsFree({ active, onNext }) {
  const [settings, setLocal] = useState(getSettings);
  const [status, setStatus] = useState("off");
  const [gesture, setGesture] = useState({ n: 0, kind: "" });
  const next = useRef(onNext);
  next.current = onNext;
  useEffect(() => subscribeSettings(setLocal), []);

  const wanted = settings.nod || settings.tongue;
  const running = wanted && !settings.handsFreePaused && active;
  const { nod, tongue, sensitivity, cameraId } = settings;
  useEffect(() => {
    if (!running) { setStatus("off"); return; }
    return watchGestures({
      nod, tongue, sensitivity, cameraId, onStatus: setStatus,
      onGesture: (kind) => { setGesture((g) => ({ n: g.n + 1, kind })); next.current?.(kind); },
    });
  }, [running, nod, tongue, sensitivity, cameraId]);

  return { wanted, paused: settings.handsFreePaused, status, gesture, togglePause: () => setSettings({ handsFreePaused: !settings.handsFreePaused }) };
}
