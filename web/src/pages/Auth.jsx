import React, { useState } from "react";
import { api } from "../lib/api.js";
import Credit from "../components/Credit.jsx";

// An invite link looks like /?invite=code. The code is kept until the person signs up.
const INVITE_KEY = "axol_invite";
function readInvite() {
  try {
    const code = new URLSearchParams(location.search).get("invite");
    if (code) { localStorage.setItem(INVITE_KEY, code.slice(0, 32)); history.replaceState(null, "", location.pathname + location.hash); }
    return localStorage.getItem(INVITE_KEY) || "";
  } catch { return ""; }
}

export default function Auth({ onAuth }) {
  const [invite] = useState(readInvite);
  const [mode, setMode] = useState("signup");
  const [f, setF] = useState({ name: "", email: "", password: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      const d = await (mode === "signup" ? api.signup({ ...f, invite }) : api.login(f));
      if (mode === "signup") localStorage.removeItem(INVITE_KEY);
      onAuth(d);
    }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="shell fade-in">
      <div className="brand"><span className="dot" />axol</div>
      <div>
        <h1>{mode === "signup" ? "A feed that's only for you." : "Welcome back."}</h1>
        <p className="muted">Every clip is picked by AI from YouTube Shorts, TikTok and Reels. It learns from how long you actually watch, not what you say you like.</p>
      </div>
      {invite && mode === "signup" && <div className="card invited" data-testid="invited">A friend invited you to axol. Create your account and your feed is ready in a minute.</div>}
      <form className="card" onSubmit={submit} style={{ display: "grid", gap: 14 }}>
        {mode === "signup" && <div className="field"><label>Name</label><input value={f.name} onChange={set("name")} placeholder="What should we call you?" autoComplete="name" /></div>}
        <div className="field"><label>Email</label><input type="email" value={f.email} onChange={set("email")} placeholder="you@example.com" autoComplete="email" required /></div>
        <div className="field"><label>Password</label><input type="password" value={f.password} onChange={set("password")} placeholder="6+ characters" autoComplete={mode === "signup" ? "new-password" : "current-password"} required /></div>
        {err && <div className="error">{err}</div>}
        <button className="btn primary" disabled={busy}>{busy && <span className="spin" />}{mode === "signup" ? "Create my feed" : "Sign in"}</button>
      </form>
      <button className="muted" style={{ textAlign: "center" }} onClick={() => setMode(mode === "signup" ? "login" : "signup")}>
        {mode === "signup" ? "Already have an account? Sign in" : "New here? Create an account"}
      </button>
      <Credit />
    </div>
  );
}
