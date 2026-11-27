import React, { useEffect, useRef, useState } from "react";
import { getSettings, setSettings, subscribeSettings } from "../lib/settings.js";
import { watchGestures } from "../lib/useHandsFree.js";
import { listCameras } from "../lib/headTracker.js";
import { tongueNeed } from "../lib/gestures.js";
import { createTongueCalibrator } from "../lib/tongueCalib.js";

const STATUS = {
  starting: "Starting the camera…",
  on: "Face found. Try a gesture.",
  noface: "The camera is working but axol can't find a face in the picture. Face the camera, come a little closer, or add light.",
  dark: "The camera picture is almost black. Uncover the lens or turn on a light.",
  stalled: "The camera is not sending a picture. Close other apps that use the camera, then try again.",
  denied: "Camera access is blocked for this site. Allow it in your browser's site settings, then try again.",
  nocamera: "No camera was found on this device.",
  error: "The camera could not be started here.",
};

/**
 * A live check: shows what the camera sees and what axol makes of it, so a person can find out
 * why a gesture is not being picked up (wrong camera, too dark, tongue reading too low…).
 * The picture stays on this device, as everywhere else.
 */
function enabledForCheck(s) {
  // If nothing is on yet, the check lets someone try every gesture before turning one on.
  const any = s.nod || s.tongue || s.winkLike || s.tiltBack || s.browPause || s.laughSave;
  const all = !any;
  return {
    nod: s.nod || all,
    tongue: s.tongue || all,
    winkLike: s.winkLike || all,
    tiltBack: s.tiltBack || all,
    browPause: s.browPause || all,
    laughSave: s.laughSave || all,
  };
}

function CameraCheck({ settings }) {
  const canvasRef = useRef(null);
  const [status, setStatus] = useState("starting");
  const [seen, setSeen] = useState({ nod: 0, tongue: 0, wink: 0, tilt: 0, brow: 0, laugh: 0, last: "" });
  const [read, setRead] = useState(null);
  const [cameras, setCameras] = useState([]);
  const { sensitivity, cameraId, tongueCalib, tongueHold } = settings;
  const on = enabledForCheck(settings);

  useEffect(() => {
    let lastShown = 0;
    setStatus("starting"); setRead(null);
    return watchGestures({
      ...on, sensitivity, cameraId, tongueCalib, tongueHold,
      onStatus: (s) => { setStatus(s); if (s === "on") listCameras().then(setCameras); },
      onGesture: (kind) => setSeen((v) => ({ ...v, [kind]: (v[kind] || 0) + 1, last: kind })),
      onFrame: (frame) => {
        const c = canvasRef.current;
        if (!c) return;
        if (c.width !== frame.width || c.height !== frame.height) { c.width = frame.width; c.height = frame.height; }
        c.getContext("2d").drawImage(frame, 0, 0);
      },
      onReading: (r, level, detector) => {
        if (r.t - lastShown < 200) return;
        lastShown = r.t;
        const need = detector?.need?.() ?? tongueNeed({ ...level.tongue, calib: tongueCalib });
        setRead(r.face ? {
          pitch: Math.round(r.pitch), roll: Math.round(r.roll || 0),
          jaw: r.jaw, run: r.run, need,
          blinkL: r.blinkL, blinkR: r.blinkR, brow: r.brow, smile: r.smile,
        } : null);
      },
    });
  }, [on.nod, on.tongue, on.winkLike, on.tiltBack, on.browPause, on.laughSave, sensitivity, cameraId, tongueCalib, tongueHold]);

  const chip = (kind, label) => (
    <span data-testid={`seen-${kind}`} key={`${kind}${seen[kind]}`} className={seen.last === kind && seen[kind] ? "flash" : ""}>
      {label} <strong>{seen[kind] || 0}</strong>
    </span>
  );
  const meter = (label, value, max, hot) => (
    <div className="tiny">
      {label} <strong style={{ color: "var(--fg)" }}>{value}</strong>
      <div className="track" style={{ height: 6, borderRadius: 999, background: "#1c1c22", overflow: "hidden", marginTop: 4 }}>
        <div style={{ height: "100%", width: `${Math.max(0, Math.min(100, (value / max) * 100))}%`, background: hot ? "var(--accent)" : "var(--fg-3)" }} />
      </div>
    </div>
  );

  return (
    <div className="camcheck" data-testid="camcheck" data-status={status}>
      <canvas ref={canvasRef} className="campreview" width="4" height="3" aria-label="What the camera sees" />
      <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
        <div className={status === "on" ? "camok" : "camwarn"} role="status" data-testid="camstatus">{STATUS[status] || status}</div>
        {status === "on" && (
          <div className="minis">
            {on.nod && chip("nod", "Nods seen")}
            {on.tongue && chip("tongue", "Tongue seen")}
            {on.winkLike && chip("wink", "Winks seen")}
            {on.tiltBack && chip("tilt", "Tilts seen")}
            {on.browPause && chip("brow", "Brow raises")}
            {on.laughSave && chip("laugh", "Laughs seen")}
          </div>
        )}
        {status === "on" && read && on.tongue && (
          <div className="tiny" data-testid="tongue-read">
            Mouth {read.jaw >= 0.12 ? "open" : "closed"} · tongue reading <strong style={{ color: "var(--fg)" }}>{read.run ?? 0}</strong> of 14 (counts at {read.need}{tongueCalib ? ", from your calibration" : ""}, with the mouth open)
            <div className="track" style={{ height: 6, borderRadius: 999, background: "#1c1c22", overflow: "hidden", marginTop: 4 }}><div style={{ height: "100%", width: `${((read.run ?? 0) / 14) * 100}%`, background: (read.run ?? 0) >= read.need && read.jaw >= 0.12 ? "var(--accent)" : "var(--fg-3)" }} /></div>
          </div>
        )}
        {status === "on" && read && (on.winkLike || on.browPause || on.laughSave || on.tiltBack) && (
          <div data-testid="face-read" style={{ display: "grid", gap: 6 }}>
            {on.winkLike && (
              <div className="tiny" data-testid="wink-read">
                Blink · left {Math.round((read.blinkL || 0) * 100)} · right {Math.round((read.blinkR || 0) * 100)}
                <div className="track" style={{ height: 6, borderRadius: 999, background: "#1c1c22", overflow: "hidden", marginTop: 4, display: "flex" }}>
                  <div style={{ height: "100%", width: `${(read.blinkL || 0) * 50}%`, background: (read.blinkL || 0) >= 0.55 && (read.blinkR || 0) <= 0.35 ? "var(--accent)" : "var(--fg-3)" }} />
                  <div style={{ height: "100%", width: `${(read.blinkR || 0) * 50}%`, background: (read.blinkR || 0) >= 0.55 && (read.blinkL || 0) <= 0.35 ? "var(--accent)" : "var(--fg-3)" }} />
                </div>
              </div>
            )}
            {on.tiltBack && meter("Head tilt", Math.abs(read.roll || 0), 40, Math.abs(read.roll || 0) >= 14)}
            {on.browPause && meter("Brows", Math.round((read.brow || 0) * 100), 100, (read.brow || 0) >= 0.28)}
            {on.laughSave && meter("Smile", Math.round((read.smile || 0) * 100), 100, (read.smile || 0) >= 0.45)}
          </div>
        )}
        {cameras.length > 1 && (
          <label className="tiny">Camera{" "}
            <select value={cameraId || ""} onChange={(e) => setSettings({ cameraId: e.target.value })} style={{ padding: "6px 10px", marginLeft: 6, maxWidth: "100%" }}>
              <option value="">Automatic (front camera)</option>
              {cameras.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>
        )}
      </div>
    </div>
  );
}

const CALIB_COPY = {
  starting: "Starting the camera…",
  closed: "Keep your mouth closed and still…",
  out: "Now stick your tongue out and hold it…",
  done: "Calibrated. Tongue scrolling will use your reading from now on.",
  fail: "Couldn't tell your tongue apart from your mouth at rest. Try better light, hold your tongue out clearly, then try again.",
};

/**
 * Two short holds — mouth closed, then tongue out — so the threshold is set for this face
 * and this lighting, rather than a one-size-fits-all number of pink rows.
 */
function TongueCalibrate({ settings, onDone }) {
  const canvasRef = useRef(null);
  const cal = useRef(null);
  const [status, setStatus] = useState("starting");
  const [step, setStep] = useState("closed");
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);
  const { sensitivity, cameraId, tongueHold } = settings;

  useEffect(() => {
    cal.current = createTongueCalibrator();
    setStep("closed"); setProgress(0); setResult(null); setStatus("starting");
    return watchGestures({
      nod: false, tongue: true, sensitivity, cameraId, tongueHold,
      onStatus: setStatus,
      onFrame: (frame) => {
        const c = canvasRef.current;
        if (!c) return;
        if (c.width !== frame.width || c.height !== frame.height) { c.width = frame.width; c.height = frame.height; }
        c.getContext("2d").drawImage(frame, 0, 0);
      },
      onReading: (r) => {
        const s = cal.current.push(r);
        setStep(s.step);
        setProgress(s.progress);
        if (s.result && s.step === "done") {
          setResult(s.result);
          setSettings({ tongueCalib: { rest: s.result.rest, out: s.result.out } });
        } else if (s.result) {
          setResult(s.result);
        }
      },
    });
  }, [sensitivity, cameraId, tongueHold]);

  const blocked = status !== "on" && status !== "starting" && step === "closed" && progress === 0;
  const copy = blocked ? (STATUS[status] || status) : (step === "closed" && status !== "on" && status !== "starting" ? (STATUS[status] || status) : CALIB_COPY[status === "starting" && step === "closed" ? "starting" : step]);

  return (
    <div className="camcheck" data-testid="tongue-calib" data-step={step} data-status={status}>
      <canvas ref={canvasRef} className="campreview" width="4" height="3" aria-label="What the camera sees" />
      <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
        <div className={step === "done" ? "camok" : step === "fail" || blocked ? "camwarn" : "camok"} role="status">{copy}</div>
        {(step === "closed" || step === "out") && status === "on" && (
          <div className="track" style={{ height: 8, borderRadius: 999, background: "#1c1c22", overflow: "hidden" }} data-testid="calib-progress">
            <div style={{ height: "100%", width: `${Math.round(progress * 100)}%`, background: "var(--accent)", transition: "width 0.15s linear" }} />
          </div>
        )}
        {step === "done" && result && (
          <div className="tiny">At rest your reading is {result.rest}; with your tongue out it is {result.out}. It will count at {result.need}.</div>
        )}
        {step === "fail" && result && (
          <div className="tiny">At rest: {result.rest}. Tongue out: {result.out}. They need to be further apart.</div>
        )}
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {(step === "done" || step === "fail") && <button className="btn sm ghost" onClick={() => onDone?.()} data-testid="calib-close">{step === "done" ? "Done" : "Close"}</button>}
          {(step === "fail") && <button className="btn sm" onClick={() => { cal.current?.reset(); setStep("closed"); setProgress(0); setResult(null); }} data-testid="calib-retry">Try again</button>}
          {step !== "done" && step !== "fail" && <button className="btn sm ghost" onClick={() => onDone?.()} data-testid="calib-cancel">Cancel</button>}
        </div>
      </div>
    </div>
  );
}

const LEVELS = [["high", "Small movements"], ["normal", "Normal"], ["low", "Big movements only"]];
const HOLDS = [["quick", "Quick"], ["normal", "Normal"], ["steady", "Hold a little longer"]];

function Switch({ on, onChange, label, hint, testid }) {
  return (
    <label className="switchrow">
      <span><strong>{label}</strong><span className="tiny" style={{ display: "block" }}>{hint}</span></span>
      <input type="checkbox" role="switch" checked={on} onChange={(e) => onChange(e.target.checked)} data-testid={testid} />
      <span className="switch" aria-hidden="true" />
    </label>
  );
}

/** Settings for scrolling and controlling clips without touching the screen. Off unless the person turns it on. */
export default function HandsFree() {
  const [s, setS] = useState(getSettings);
  const [checking, setChecking] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  useEffect(() => subscribeSettings(setS), []);
  const canCamera = !!navigator.mediaDevices?.getUserMedia;
  // Turning a gesture on also un-pauses hands-free, so the switch always does what it says.
  const set = (patch) => setSettings({ ...patch, handsFreePaused: false });
  const any = s.nod || s.tongue || s.winkLike || s.tiltBack || s.browPause || s.laughSave;

  return (
    <div className="card" data-testid="handsfree">
      <div className="tiny" style={{ marginBottom: 6 }}>HANDS-FREE</div>
      <h2>Scroll and react with your face</h2>
      <p className="muted" style={{ margin: "6px 0 14px" }}>Go to the next clip, like one, go back, pause, or save a laugh — without touching the screen. axol watches through your {matchMedia("(pointer: coarse)").matches ? "phone's front camera" : "computer's camera"} while you are on Reels. Everything stays on this device.</p>
      {!canCamera && <div className="error" style={{ marginBottom: 10 }}>This browser doesn't give axol a camera, so these can't be used here.</div>}
      <div className="tiny" style={{ marginBottom: 6 }}>SCROLL</div>
      <div className="switches">
        <Switch on={s.nod} onChange={(v) => set({ nod: v })} label="Nod to scroll" hint="Nod your head down and back up." testid="switch-nod" />
        <Switch on={s.tongue} onChange={(v) => set({ tongue: v })} label="Tongue to scroll" hint="Stick your tongue out for a moment. Works best after a quick calibration, in good light." testid="switch-tongue" />
      </div>
      <div className="tiny" style={{ margin: "16px 0 6px" }}>FACE GESTURES</div>
      <div className="switches">
        <Switch on={s.winkLike} onChange={(v) => set({ winkLike: v })} label="Wink to like" hint="Close one eye and keep the other open. A normal blink does not count." testid="switch-wink" />
        <Switch on={s.tiltBack} onChange={(v) => set({ tiltBack: v })} label="Tilt to go back" hint="Tip your head to one side and back up to return to the last clip." testid="switch-tilt" />
        <Switch on={s.browPause} onChange={(v) => set({ browPause: v })} label="Raise your brows to pause" hint="Lift your eyebrows and hold them to pause or play." testid="switch-brow" />
        <Switch on={s.laughSave} onChange={(v) => set({ laughSave: v })} label="Save clips that make you laugh" hint="A real laugh is saved to Made me laugh on your dashboard, with a recap you can share. Only the clip is remembered, not your face." testid="switch-laugh" />
      </div>
      <div className="tiny" style={{ margin: "16px 0 6px" }}>ON REELS</div>
      <div className="switches">
        <Switch on={s.gestureHud} onChange={(v) => set({ gestureHud: v })} label="Show a live gesture HUD" hint="A small picture of what the camera sees, and which gesture just fired. The picture never leaves this device." testid="switch-hud" />
      </div>
      {any && (
        <div style={{ marginTop: 14 }}>
          <div className="tiny" style={{ marginBottom: 6 }}>How big a movement counts</div>
          <div className="chips" role="radiogroup" aria-label="Sensitivity">
            {LEVELS.map(([id, label]) => <button key={id} role="radio" aria-checked={s.sensitivity === id} className={`chip ${s.sensitivity === id ? "on" : ""}`} onClick={() => setSettings({ sensitivity: id })}>{label}</button>)}
          </div>
        </div>
      )}
      {s.tongue && (
        <div style={{ marginTop: 14 }}>
          <div className="tiny" style={{ marginBottom: 6 }}>How long to hold your tongue out</div>
          <div className="chips" role="radiogroup" aria-label="Tongue hold">
            {HOLDS.map(([id, label]) => <button key={id} role="radio" aria-checked={s.tongueHold === id} className={`chip ${s.tongueHold === id ? "on" : ""}`} data-testid={`hold-${id}`} onClick={() => setSettings({ tongueHold: id })}>{label}</button>)}
          </div>
        </div>
      )}
      {s.tongue && s.tongueCalib && !calibrating && (
        <p className="tiny" style={{ margin: "12px 0 0" }} data-testid="calib-summary">
          Calibrated for you: counts at {tongueNeed({ calib: s.tongueCalib })} of 14.{" "}
          <button className="textbtn" onClick={() => setSettings({ tongueCalib: null })} data-testid="calib-clear">Clear</button>
        </p>
      )}
      <div style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button className="btn sm ghost" onClick={() => { setChecking((c) => !c); if (!checking) setCalibrating(false); }} disabled={!canCamera} data-testid="camcheck-toggle">{checking ? "Stop the camera check" : "Check my camera"}</button>
        {s.tongue && (
          <button className="btn sm" onClick={() => { setCalibrating((c) => !c); if (!calibrating) setChecking(false); }} disabled={!canCamera} data-testid="calib-toggle">
            {calibrating ? "Stop calibration" : s.tongueCalib ? "Recalibrate tongue" : "Calibrate tongue"}
          </button>
        )}
      </div>
      {checking && <CameraCheck settings={s} />}
      {calibrating && <TongueCalibrate settings={s} onDone={() => setCalibrating(false)} />}
      <p className="tiny" style={{ margin: "14px 0 0" }}>
        Your browser will ask for camera access the first time. The picture is analysed on this device and then discarded: nothing is recorded, saved or sent to axol, except the clip you laughed at or liked.
        The camera is only on while Reels is showing, and you can pause it from the pill at the top of the player.
      </p>
    </div>
  );
}
