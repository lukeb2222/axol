import React from "react";

const COPY = {
  nod: { mark: "▲", label: "Next", hint: "Nod" },
  tongue: { mark: "▲", label: "Next", hint: "Tongue" },
  wink: { mark: "♥", label: "Liked", hint: "Wink" },
  tilt: { mark: "▲", label: "Back", hint: "Head tilt" },
  brow: { mark: "❚❚", label: "Paused", hint: "Eyebrows" },
  "brow-play": { mark: "▶", label: "Playing", hint: "Eyebrows" },
  laugh: { mark: "HA!", label: "Made me laugh", hint: "Laugh" },
};

/** A short, centered flash when a hands-free gesture fires. Decorative: pointer-events none. */
export default function GestureFlash({ kind, label, today }) {
  if (!kind) return null;
  const copy = COPY[kind] || { mark: "✦", label: kind, hint: "" };
  const text = label || copy.label;
  const extra = kind === "laugh" && today > 0 ? `${today} today` : copy.hint;
  return (
    <div className="g-flash" data-testid="gesture-flash" data-kind={kind === "brow-play" ? "brow" : kind} aria-live="polite">
      <div className="g-flash-core">
        <div className="g-flash-mark">{copy.mark}</div>
        <div className="g-flash-label">{text}</div>
        {extra && <div className="g-flash-hint">{extra}</div>}
      </div>
    </div>
  );
}
