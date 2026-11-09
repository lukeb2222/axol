import React, { useState } from "react";
import { api } from "../lib/api.js";

export default function Auth({ onAuth }) {
  const [mode, setMode] = useState("signup");
  const [f, setF] = useState({ name: "", email: "", password: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr("");
    try { onAuth(await (mode === "signup" ? api.signup(f) : api.login(f))); }
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
    </div>
  );
}
