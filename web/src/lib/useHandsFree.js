import { useEffect, useRef, useState } from "react";
import { getSettings, setSettings, subscribeSettings } from "./settings.js";
import { createNodDetector, createTongueDetector, SENSITIVITY } from "./gestures.js";
import { startHeadTracker } from "./headTracker.js";

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
  const { nod, tongue, sensitivity } = settings;
  useEffect(() => {
    if (!running) { setStatus("off"); return; }
    const level = SENSITIVITY[sensitivity] || SENSITIVITY.normal;
    const nods = nod ? createNodDetector(level.nod) : null;
    const tongues = tongue ? createTongueDetector(level.tongue) : null;
    const fire = (kind) => { setGesture((g) => ({ n: g.n + 1, kind })); next.current?.(kind); };
    return startHeadTracker({
      tongue, margin: level.margin, onStatus: setStatus,
      onReading: (r) => {
        if (nods?.push(r)) fire("nod");
        if (tongues?.push(r)) fire("tongue");
      },
    });
  }, [running, nod, tongue, sensitivity]);

  return { wanted, paused: settings.handsFreePaused, status, gesture, togglePause: () => setSettings({ handsFreePaused: !settings.handsFreePaused }) };
}
