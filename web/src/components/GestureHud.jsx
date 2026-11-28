import React from "react";

const KIND = { nod: "Nod", tongue: "Tongue", wink: "Wink", tilt: "Tilt", brow: "Brows", laugh: "Laugh" };

/**
 * A live, on-device picture of what the camera sees, plus the last gesture that fired.
 * The canvas is drawn by the head tracker; this component never sends the picture anywhere.
 */
export default function GestureHud({ canvasRef, status, gesture }) {
  const kind = gesture?.kind && gesture.n ? KIND[gesture.kind] || gesture.kind : "";
  return (
    <div className="g-hud" data-testid="gesture-hud" data-status={status} data-last={gesture?.kind || ""} data-fired={kind ? gesture.n : ""}>
      <canvas ref={canvasRef} className="g-hud-cam" width="160" height="120" aria-hidden="true" />
      <div className="g-hud-cap">
        <span className={`g-hud-dot ${status === "on" ? "on" : ""}`} />
        <span className="g-hud-kind" key={kind ? `${gesture.kind}-${gesture.n}` : "idle"}>
          {kind || (status === "on" ? "Watching" : status === "starting" ? "Starting…" : "No face")}
        </span>
      </div>
    </div>
  );
}
