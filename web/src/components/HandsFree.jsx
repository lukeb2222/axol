import React, { useEffect, useRef, useState } from "react";
import { getSettings, setSettings, subscribeSettings } from "../lib/settings.js";
import { watchGestures } from "../lib/useHandsFree.js";
import { listCameras } from "../lib/headTracker.js";

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
function CameraCheck({ settings }) {
  const canvasRef = useRef(null);
  const [status, setStatus] = useState("starting");
  const [seen, setSeen] = useState({ nod: 0, tongue: 0, last: "" });
  const [read, setRead] = useState(null);
  const [cameras, setCameras] = useState([]);
  const { sensitivity, cameraId } = settings;
  // With nothing switched on yet, the check looks for both.
  const nod = settings.nod || !settings.tongue, tongue = settings.tongue || !settings.nod;

  useEffect(() => {
    let lastShown = 0;
    setStatus("starting"); setRead(null);
    return watchGestures({
      nod, tongue, sensitivity, cameraId,
      onStatus: (s) => { setStatus(s); if (s === "on") listCameras().then(setCameras); },
      onGesture: (kind) => setSeen((v) => ({ ...v, [kind]: v[kind] + 1, last: kind })),
      onFrame: (frame) => {
        const c = canvasRef.current;
        if (!c) return;
        if (c.width !== frame.width || c.height !== frame.height) { c.width = frame.width; c.height = frame.height; }
        c.getContext("2d").drawImage(frame, 0, 0);
      },
      onReading: (r, level) => {
        if (r.t - lastShown < 200) return;
        lastShown = r.t;
        setRead(r.face ? { pitch: Math.round(r.pitch), jaw: r.jaw, run: r.run, need: level.tongue.minRun } : null);
      },
    });
  }, [nod, tongue, sensitivity, cameraId]);

  return (
    <div className="camcheck" data-testid="camcheck" data-status={status}>
      <canvas ref={canvasRef} className="campreview" width="4" height="3" aria-label="What the camera sees" />
      <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
        <div className={status === "on" ? "camok" : "camwarn"} role="status" data-testid="camstatus">{STATUS[status] || status}</div>
        {status === "on" && (
          <div className="minis">
            {nod && <span data-testid="seen-nod" key={`n${seen.nod}`} className={seen.last === "nod" && seen.nod ? "flash" : ""}>Nods seen <strong>{seen.nod}</strong></span>}
            {tongue && <span data-testid="seen-tongue" key={`t${seen.tongue}`} className={seen.last === "tongue" && seen.tongue ? "flash" : ""}>Tongue seen <strong>{seen.tongue}</strong></span>}
          </div>
        )}
        {status === "on" && read && tongue && (
          <div className="tiny" data-testid="tongue-read">
            Mouth {read.jaw >= 0.12 ? "open" : "closed"} · tongue reading <strong style={{ color: "var(--fg)" }}>{read.run ?? 0}</strong> of 14 (counts at {read.need}, with the mouth open)
            <div className="track" style={{ height: 6, borderRadius: 999, background: "#1c1c22", overflow: "hidden", marginTop: 4 }}><div style={{ height: "100%", width: `${((read.run ?? 0) / 14) * 100}%`, background: (read.run ?? 0) >= read.need && read.jaw >= 0.12 ? "var(--accent)" : "var(--fg-3)" }} /></div>
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

const LEVELS = [["high", "Small movements"], ["normal", "Normal"], ["low", "Big movements only"]];

function Switch({ on, onChange, label, hint, testid }) {
  return (
    <label className="switchrow">
      <span><strong>{label}</strong><span className="tiny" style={{ display: "block" }}>{hint}</span></span>
      <input type="checkbox" role="switch" checked={on} onChange={(e) => onChange(e.target.checked)} data-testid={testid} />
      <span className="switch" aria-hidden="true" />
    </label>
  );
}

/** Settings for scrolling without touching the screen. Off unless the person turns it on. */
export default function HandsFree() {
  const [s, setS] = useState(getSettings);
  const [checking, setChecking] = useState(false);
  useEffect(() => subscribeSettings(setS), []);
  const canCamera = !!navigator.mediaDevices?.getUserMedia;
  // Turning a gesture on also un-pauses hands-free, so the switch always does what it says.
  const set = (patch) => setSettings({ ...patch, handsFreePaused: false });
  const any = s.nod || s.tongue;

  return (
    <div className="card" data-testid="handsfree">
      <div className="tiny" style={{ marginBottom: 6 }}>HANDS-FREE SCROLLING</div>
      <h2>Scroll without touching</h2>
      <p className="muted" style={{ margin: "6px 0 14px" }}>Go to the next clip with a gesture. axol watches through your {matchMedia("(pointer: coarse)").matches ? "phone's front camera" : "computer's camera"} while you are on Reels.</p>
      {!canCamera && <div className="error" style={{ marginBottom: 10 }}>This browser doesn't give axol a camera, so these can't be used here.</div>}
      <div className="switches">
        <Switch on={s.nod} onChange={(v) => set({ nod: v })} label="Nod to scroll" hint="Nod your head down and back up." testid="switch-nod" />
        <Switch on={s.tongue} onChange={(v) => set({ tongue: v })} label="Tongue to scroll" hint="Stick your tongue out for a moment. Experimental: works best in good light." testid="switch-tongue" />
      </div>
      {any && (
        <div style={{ marginTop: 14 }}>
          <div className="tiny" style={{ marginBottom: 6 }}>How big a movement counts</div>
          <div className="chips" role="radiogroup" aria-label="Sensitivity">
            {LEVELS.map(([id, label]) => <button key={id} role="radio" aria-checked={s.sensitivity === id} className={`chip ${s.sensitivity === id ? "on" : ""}`} onClick={() => setSettings({ sensitivity: id })}>{label}</button>)}
          </div>
        </div>
      )}
      <div style={{ marginTop: 14 }}>
        <button className="btn sm ghost" onClick={() => setChecking((c) => !c)} disabled={!canCamera} data-testid="camcheck-toggle">{checking ? "Stop the camera check" : "Check my camera"}</button>
        {checking && <CameraCheck settings={s} />}
      </div>
      <p className="tiny" style={{ margin: "14px 0 0" }}>
        Your browser will ask for camera access the first time. The picture is analysed on this device and then discarded: nothing is recorded, saved or sent to axol.
        The camera is only on while Reels is showing, and you can pause it from the pill at the top of the player.
      </p>
    </div>
  );
}
