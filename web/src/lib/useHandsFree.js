import { useEffect, useRef, useState } from "react";
import { getSettings, setSettings, subscribeSettings, wantsCamera } from "./settings.js";
import {
  createNodDetector, createTongueDetector, createWinkDetector, createTiltDetector,
  createBrowDetector, createLaughDetector, SENSITIVITY, TONGUE_HOLD,
} from "./gestures.js";
import { startHeadTracker } from "./headTracker.js";

/**
 * Start the camera and turn its readings into gestures. Each flag chooses what to look for.
 * Returns a function that stops everything.
 */
export function watchGestures({
  nod, tongue, winkLike, tiltBack, browPause, laughSave, faces,
  sensitivity, cameraId, tongueCalib, tongueHold, onGesture, onStatus, onReading, onFrame,
}) {
  const level = SENSITIVITY[sensitivity] || SENSITIVITY.normal;
  const wantFaces = !!(faces || winkLike || tiltBack || browPause || laughSave);
  const nods = nod ? createNodDetector(level.nod) : null;
  const tongues = tongue ? createTongueDetector({
    ...level.tongue,
    holdMs: TONGUE_HOLD[tongueHold] ?? TONGUE_HOLD.normal,
    calib: tongueCalib,
  }) : null;
  const winks = winkLike ? createWinkDetector(level.wink) : null;
  const tilts = tiltBack ? createTiltDetector(level.tilt) : null;
  const brows = browPause ? createBrowDetector(level.brow) : null;
  const laughs = laughSave ? createLaughDetector(level.laugh) : null;
  return startHeadTracker({
    tongue, faces: wantFaces, margin: level.margin, deviceId: cameraId, onStatus, onFrame,
    onReading: (r) => {
      onReading?.(r, level, tongues);
      if (window.__axolDebug) window.__axolDebug.push(r);
      if (nods?.push(r)) onGesture("nod");
      if (tongues?.push(r)) onGesture("tongue");
      if (winks?.push(r)) onGesture("wink");
      if (tilts?.push(r)) onGesture("tilt");
      if (brows?.push(r)) onGesture("brow");
      if (laughs?.push(r)) onGesture("laugh");
    },
  });
}

/**
 * Hands-free control for the reel player. While it is switched on in settings and `active` is
 * true (the reels are on screen), the camera watches for the enabled gestures and calls
 * `onGesture(kind)`. The camera is released whenever the reels are not showing.
 */
export function useHandsFree({ active, onGesture, onFrame }) {
  const [settings, setLocal] = useState(getSettings);
  const [status, setStatus] = useState("off");
  const [gesture, setGesture] = useState({ n: 0, kind: "" });
  const next = useRef(onGesture);
  next.current = onGesture;
  const frame = useRef(onFrame);
  frame.current = onFrame;
  useEffect(() => subscribeSettings(setLocal), []);

  const wanted = wantsCamera(settings);
  const running = wanted && !settings.handsFreePaused && active;
  const { nod, tongue, winkLike, tiltBack, browPause, laughSave, gestureHud, sensitivity, cameraId, tongueCalib, tongueHold } = settings;
  useEffect(() => {
    if (!running) { setStatus("off"); return; }
    return watchGestures({
      nod, tongue, winkLike, tiltBack, browPause, laughSave, faces: gestureHud,
      sensitivity, cameraId, tongueCalib, tongueHold, onStatus: setStatus,
      onFrame: (c) => frame.current?.(c),
      onGesture: (kind) => { setGesture((g) => ({ n: g.n + 1, kind })); next.current?.(kind); },
    });
  }, [running, nod, tongue, winkLike, tiltBack, browPause, laughSave, gestureHud, sensitivity, cameraId, tongueCalib, tongueHold]);

  return {
    wanted, paused: settings.handsFreePaused, status, gesture, hud: !!settings.gestureHud,
    togglePause: () => setSettings({ handsFreePaused: !settings.handsFreePaused }),
  };
}
