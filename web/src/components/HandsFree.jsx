import React, { useEffect, useState } from "react";
import { getSettings, setSettings, subscribeSettings } from "../lib/settings.js";

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
      <p className="tiny" style={{ margin: "14px 0 0" }}>
        Your browser will ask for camera access the first time. The picture is analysed on this device and then discarded: nothing is recorded, saved or sent to axol.
        The camera is only on while Reels is showing, and you can pause it from the pill at the top of the player.
      </p>
    </div>
  );
}
