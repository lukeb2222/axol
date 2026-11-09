import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { sound } from "../lib/youtube.js";
import VideoCard from "../components/VideoCard.jsx";
import Toasts from "../components/Toasts.jsx";
import { Volume } from "../components/Icons.jsx";

const PREFETCH_AT = 3;

export default function Feed({ user, onOpenProfile, paused }) {
  const [items, setItems] = useState([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(true);
  const [empty, setEmpty] = useState(false);
  const [soundOn, setSoundOn] = useState(sound.on);
  const [toasts, setToasts] = useState([]);
  const [learnedCount, setLearnedCount] = useState(0);
  const [hint, setHint] = useState(() => !localStorage.getItem("axol_hinted"));
  const feedRef = useRef(null);
  const fetching = useRef(false);

  const fetchMore = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    try {
      const d = await api.feed(8);
      if (typeof d.discoveryReady === "boolean") setDiscoveryReady(d.discoveryReady);
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.impressionId));
        const next = d.items.filter((i) => !seen.has(i.impressionId));
        if (!next.length && !prev.length) setEmpty(true);
        return [...prev, ...next];
      });
    } catch (e) {
      console.warn(e);
    } finally {
      fetching.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchMore(); }, [fetchMore]);
  useEffect(() => { if (items.length && active >= items.length - PREFETCH_AT) fetchMore(); }, [active, items.length, fetchMore]);

  // Which slide is on screen.
  useEffect(() => {
    const root = feedRef.current;
    if (!root) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting && e.intersectionRatio >= 0.6) {
          const idx = Number(e.target.dataset.idx);
          setActive(idx);
          if (idx > 0 && hint) { setHint(false); localStorage.setItem("axol_hinted", "1"); }
        }
      }
    }, { root, threshold: [0.6] });
    root.querySelectorAll(".slide-wrap").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [items.length, hint]);

  // Keyboard: arrows to move, M mute, L like-less-friction is handled per card by double tap.
  useEffect(() => {
    const onKey = (e) => {
      if (["ArrowDown", "PageDown", " "].includes(e.key) && !e.target.closest("textarea,input")) { e.preventDefault(); scrollTo(active + 1); }
      if (["ArrowUp", "PageUp"].includes(e.key)) { e.preventDefault(); scrollTo(active - 1); }
      if (e.key.toLowerCase() === "m") toggleSound();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const scrollTo = (idx) => {
    const el = feedRef.current?.querySelector(`[data-idx="${idx}"]`);
    el?.scrollIntoView({ behavior: "smooth" });
  };

  const toggleSound = () => { sound.on = !sound.on; setSoundOn(sound.on); };

  const pushToast = (t) => {
    const id = Math.random();
    setToasts((ts) => [...ts.slice(-2), { id, ...t }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), t.big ? 5200 : 3300);
  };

  const onFinished = useCallback((r) => {
    if (r?.learned?.deltas?.length) {
      const deltas = r.learned.deltas.filter((d) => Math.abs(d.delta) >= 0.02).slice(0, 3);
      if (deltas.length) { pushToast({ deltas }); setLearnedCount((n) => n + 1); }
    }
    if (r?.synth?.insight) pushToast({ big: true, text: r.synth.insight });
  }, []);

  const onHide = useCallback((impressionId) => {
    setItems((prev) => prev.filter((i) => i.impressionId !== impressionId));
  }, []);

  const [discoveryReady, setDiscoveryReady] = useState(true);
  const [links, setLinks] = useState("");
  const [importing, setImporting] = useState(false);
  const doImport = async () => {
    setImporting(true);
    try { await api.importLinks({ text: links }); setLinks(""); setEmpty(false); setLoading(true); fetchMore(); } catch (e) { console.warn(e); } finally { setImporting(false); }
  };

  return (
    <>
      <div className="topbar">
        <button className={`pill ${soundOn ? "hot" : ""}`} onClick={toggleSound}><Volume muted={!soundOn} />{soundOn ? "Sound on" : "Tap for sound"}</button>
        <div className="row">
          {learnedCount > 0 && <span className="pill hot">✦ tuned ×{learnedCount}</span>}
          <button className="avatar" onClick={onOpenProfile} title="Your taste profile">{(user.name || "?")[0].toUpperCase()}</button>
        </div>
      </div>
      <div className="feed" ref={feedRef}>
        {items.map((item, idx) => (
          <div key={item.impressionId} className="slide-wrap" data-idx={idx}>
            <VideoCard item={item} active={idx === active && !paused} near={Math.abs(idx - active) === 1} soundOn={soundOn} paused={paused}
              onFinished={onFinished} onHide={onHide} showHint={hint && idx === 0} />
          </div>
        ))}
        {(loading || !items.length) && (
          <div className="loading-slide">
            <div className="orb" />
            {empty ? (
              <div style={{ display: "grid", gap: 12, maxWidth: 360 }}>
                <h2>{discoveryReady ? "Still gathering clips for you" : "Discovery isn't connected yet"}</h2>
                <p className="muted">
                  {discoveryReady
                    ? "Discovery is running across platforms. Give it a moment and try again."
                    : "Add a free YouTube Data API key (YOUTUBE_API_KEY) or a discovery provider on the server to auto-fill the feed. Until then, paste Shorts, TikTok or Reels links and they'll show up here, tagged and ranked."}
                </p>
                <textarea style={{ minHeight: 70 }} value={links} onChange={(e) => setLinks(e.target.value)} placeholder="Paste a few video links…" />
                <div className="row" style={{ justifyContent: "center" }}>
                  <button className="btn sm primary" onClick={doImport} disabled={!links.trim() || importing}>{importing && <span className="spin" />}Add clips</button>
                  <button className="btn sm ghost" onClick={() => { setEmpty(false); setLoading(true); fetchMore(); }}>Try again</button>
                </div>
              </div>
            ) : <p className="muted">Finding the next ones…</p>}
          </div>
        )}
      </div>
      <Toasts items={toasts} />
    </>
  );
}
