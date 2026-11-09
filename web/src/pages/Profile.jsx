import React, { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { X, Refresh } from "../components/Icons.jsx";

export default function Profile({ user, onClose, onLogout }) {
  const [p, setP] = useState(null);
  const [busy, setBusy] = useState("");
  const [links, setLinks] = useState("");
  const [msg, setMsg] = useState("");
  const [health, setHealth] = useState(null);

  const load = () => api.profile().then((d) => setP(d.profile));
  useEffect(() => { load(); api.health().then(setHealth).catch(() => {}); }, []);

  const retune = async () => {
    setBusy("retune");
    try { const d = await api.refresh(); setP(d.profile); setMsg(d.synth?.insight || "Re-tuned."); } catch (e) { setMsg(e.message); } finally { setBusy(""); }
  };
  const act = async (tag, action) => { const d = await api.interest({ tag, action }); setP(d.profile); };
  const doImport = async () => {
    setBusy("import");
    try { const d = await api.importLinks({ text: links }); setMsg(`Added ${d.added} of ${d.total} links to your catalog.`); setLinks(""); } catch (e) { setMsg(e.message); } finally { setBusy(""); }
  };

  if (!p) return <div className="sheet"><div className="loading-slide"><div className="orb" /></div></div>;
  const maxW = Math.max(0.01, ...p.interests.map((i) => Math.abs(i.weight)));
  const hours = p.stats.watched_ms / 3600e3;

  return (
    <div className="sheet">
      <div className="shell">
        <div className="row between">
          <div className="brand" style={{ fontSize: 24 }}><span className="dot" />your taste</div>
          <button className="pill" onClick={onClose}><X /></button>
        </div>

        <div className="card" style={{ background: "linear-gradient(135deg, rgba(139,92,246,0.25), var(--bg-2))" }}>
          <div className="tiny" style={{ marginBottom: 6 }}>WHAT THE FEED THINKS OF YOU</div>
          <p style={{ margin: 0, fontSize: 16, lineHeight: 1.5 }}>{p.summary || "Watch a few clips and this will fill in."}</p>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn sm" onClick={retune} disabled={!!busy}>{busy === "retune" ? <span className="spin" /> : <Refresh style={{ width: 16 }} />}Re-tune now</button>
            <span className="tiny">{p.eventsSinceSynth} clips since last tune · {p.synthCount} tunes</span>
          </div>
        </div>

        <div className="stats">
          <div className="stat"><div className="v">{p.stats.views}</div><div className="k">clips</div></div>
          <div className="stat"><div className="v">{hours < 1 ? `${Math.round(p.stats.watched_ms / 60000)}m` : `${hours.toFixed(1)}h`}</div><div className="k">watched</div></div>
          <div className="stat"><div className="v">{p.stats.likes || 0}</div><div className="k">likes</div></div>
        </div>

        <div>
          <div className="row between" style={{ marginBottom: 10 }}><h2>Interests</h2><span className="tiny">▲ boost · ✕ mute</span></div>
          <div className="bars">
            {p.interests.slice(0, 30).map((i) => (
              <div className="bar" key={i.tag}>
                <div className="lbl">{i.tag.replace(/-/g, " ")}<span className={`badge ${i.origin}`}>{i.origin}</span></div>
                <div className="row" style={{ gap: 6 }}>
                  <span className="tiny">{i.impressions} seen</span>
                  <button className="mini" onClick={() => act(i.tag, "boost")}>▲</button>
                  <button className="mini" onClick={() => act(i.tag, "mute")}>✕</button>
                </div>
                <div className="track"><div className={`fill ${i.weight < 0 ? "neg" : ""}`} style={{ width: `${Math.max(3, (Math.abs(i.weight) / maxW) * 100)}%` }} /></div>
              </div>
            ))}
          </div>
          {p.avoid.length > 0 && <p className="tiny" style={{ marginTop: 10 }}>Muted: {p.avoid.join(", ")}</p>}
        </div>

        {p.sources.length > 0 && (
          <div>
            <h2 style={{ marginBottom: 8 }}>Platforms</h2>
            <div className="row wrap">{p.sources.map((s) => <span key={s.source} className={`srcpill ${s.source}`}>{s.source} · {s.views} · {s.affinity >= 0 ? "+" : ""}{s.affinity.toFixed(2)}</span>)}</div>
          </div>
        )}

        <div>
          <h2 style={{ marginBottom: 8 }}>Add clips from anywhere</h2>
          <p className="tiny">Paste TikTok, Reels or Shorts links. They join your catalog, get tagged by AI, and teach the feed what you like.</p>
          <textarea style={{ minHeight: 80 }} value={links} onChange={(e) => setLinks(e.target.value)} placeholder="https://www.tiktok.com/@…/video/…  https://www.instagram.com/reel/…" />
          <button className="btn sm" style={{ marginTop: 8 }} onClick={doImport} disabled={!links.trim() || !!busy}>{busy === "import" && <span className="spin" />}Import</button>
        </div>

        {p.log.length > 0 && (
          <div>
            <h2 style={{ marginBottom: 8 }}>Tuning history</h2>
            <div className="log">
              {p.log.map((l, i) => (
                <div className="item" key={i}>
                  <div>{l.summary}</div>
                  <div className="tiny">{new Date(l.created_at).toLocaleString()} · {l.mode === "ai" ? "AI" : "heuristic"}{l.changes?.adjustments?.length ? ` · ${l.changes.adjustments.map((a) => `${a.delta > 0 ? "▲" : "▼"}${a.tag}`).join(" ")}` : ""}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {msg && <div className="card" style={{ borderColor: "rgba(200,255,61,0.4)" }}>{msg}</div>}
        {health && <p className="tiny">Engine: AI {health.ai.enabled ? `on (${health.ai.model})` : "off, heuristics"} · YouTube {health.sources.youtube} · catalog {health.catalog} clips</p>}
        <button className="btn ghost" onClick={onLogout}>Sign out {user.email}</button>
      </div>
    </div>
  );
}
