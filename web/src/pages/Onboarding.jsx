import React, { useEffect, useState } from "react";
import { api } from "../lib/api.js";

const STEPS = ["Reading what you love", "Mapping your taste", "Searching three platforms", "Tagging clips for you"];

export default function Onboarding({ onDone, name }) {
  const [chips, setChips] = useState([]);
  const [picked, setPicked] = useState(new Set());
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [err, setErr] = useState("");

  useEffect(() => { api.chips().then((d) => setChips(d.chips)).catch(() => {}); }, []);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setStep((s) => Math.min(STEPS.length - 1, s + 1)), 1800);
    return () => clearInterval(t);
  }, [busy]);

  const toggle = (c) => setPicked((p) => { const n = new Set(p); n.has(c) ? n.delete(c) : n.add(c); return n; });
  const submit = async () => {
    setBusy(true); setErr(""); setStep(0);
    try { const d = await api.onboard({ text, chips: [...picked] }); onDone(d.profile); }
    catch (e) { setErr(e.message); setBusy(false); }
  };

  if (busy) {
    return (
      <div className="shell fade-in" style={{ justifyContent: "center" }}>
        <div className="loading-slide" style={{ height: "auto" }}>
          <div className="orb" />
          <h1>Building your feed{name ? `, ${name.split(" ")[0]}` : ""}</h1>
          <div className="steps" style={{ textAlign: "left", marginTop: 16 }}>
            {STEPS.map((s, i) => <div key={s} className={`step ${i < step ? "done" : i === step ? "active" : ""}`}><span className="ind">{i < step ? "✓" : i + 1}</span>{s}</div>)}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="shell fade-in">
      <div className="brand"><span className="dot" />axol</div>
      <div>
        <h1>What do you love?</h1>
        <p className="muted">Passions, obsessions, things you want to see more of, things you never want to see. Write it how you'd tell a friend.</p>
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="I'm obsessed with skateboarding and jazz piano. I want to get better at cooking, mostly street food. Love oddly satisfying stuff and space. No politics, no pranks." />
      <div>
        <h2 style={{ marginBottom: 10 }}>Tap anything that fits</h2>
        <div className="chips">
          {chips.map((c) => <button key={c} className={`chip ${picked.has(c) ? "on" : ""}`} onClick={() => toggle(c)}>{c.replace(/-/g, " ")}</button>)}
        </div>
      </div>
      {err && <div className="error">{err}</div>}
      <button className="btn primary" onClick={submit} disabled={text.trim().length < 3 && picked.size === 0}>Build my feed</button>
      <p className="tiny" style={{ textAlign: "center" }}>You can change all of this later. The feed keeps rewriting itself based on what you watch.</p>
    </div>
  );
}
