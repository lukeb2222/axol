import React, { useCallback, useEffect, useRef, useState } from "react";
import YouTubePlayer from "./YouTubePlayer.jsx";
import EmbedPlayer from "./EmbedPlayer.jsx";
import { api, beacon } from "../lib/api.js";
import { Heart, EyeOff, Share, Info, Play } from "./Icons.jsx";

const ASSUMED_EMBED_MS = 20000; // typical short clip when the platform hides duration
const PROGRESS_EVERY_MS = 2000;

export default function VideoCard({ item, active, near, soundOn, paused, onFinished, onHide, showHint }) {
  const isYT = item.embedKind === "youtube";
  const [liked, setLiked] = useState(false);
  const [bursts, setBursts] = useState([]);
  const [userPaused, setUserPaused] = useState(false);
  const [progress, setProgress] = useState(0);
  const [showInfo, setShowInfo] = useState(false);

  // Watch accounting lives in refs so it never triggers renders.
  const acc = useRef({ watchedMs: 0, durationMs: item.durationMs || 0, replays: 0, lastTick: 0, lastSent: 0, finalized: false, activatedAt: 0 });
  const dwell = useRef(null);
  const tapRef = useRef({ last: 0, timer: null });

  const sendProgress = useCallback((force = false) => {
    const a = acc.current;
    const t = Date.now();
    if (!force && t - a.lastSent < PROGRESS_EVERY_MS) return;
    a.lastSent = t;
    beacon({ impressionId: item.impressionId, type: "progress", watchedMs: Math.round(a.watchedMs), durationMs: Math.round(a.durationMs), replays: a.replays });
  }, [item.impressionId]);

  // YouTube ticks: count only time that was actually playing.
  const onTick = useCallback(({ currentTime, duration, playing }) => {
    const a = acc.current;
    if (duration > 0) a.durationMs = duration * 1000;
    const t = Date.now();
    if (playing && a.lastTick) a.watchedMs += Math.min(1000, t - a.lastTick);
    a.lastTick = playing ? t : 0;
    if (duration > 0) setProgress(Math.min(1, currentTime / duration));
    sendProgress();
  }, [sendProgress]);

  // Embeds: dwell time while the card is active and the tab is visible.
  useEffect(() => {
    if (isYT || !active || paused) return;
    acc.current.durationMs = acc.current.durationMs || ASSUMED_EMBED_MS;
    const start = Date.now();
    let last = start;
    dwell.current = setInterval(() => {
      if (document.visibilityState !== "visible") { last = Date.now(); return; }
      const t = Date.now();
      acc.current.watchedMs += t - last; last = t;
      setProgress(Math.min(1, acc.current.watchedMs / acc.current.durationMs));
      sendProgress();
    }, 250);
    return () => clearInterval(dwell.current);
  }, [isYT, active, paused, sendProgress]);

  // Finalize when the card leaves the screen (or the page is hidden/unloaded).
  const finalize = useCallback((reason = "finish") => {
    const a = acc.current;
    if (a.finalized) return;
    a.finalized = true;
    const skipped = a.watchedMs < 2500;
    beacon({ impressionId: item.impressionId, type: reason, watchedMs: Math.round(a.watchedMs), durationMs: Math.round(a.durationMs), replays: a.replays, skipped })
      .then((r) => r && onFinished?.(r));
  }, [item.impressionId, onFinished]);

  useEffect(() => {
    if (active) { acc.current.activatedAt = Date.now(); acc.current.finalized = false; return; }
    if (acc.current.activatedAt) finalize("finish");
  }, [active, finalize]);

  useEffect(() => {
    if (!active) return;
    const onHidden = () => { if (document.visibilityState === "hidden") sendProgress(true); };
    const onUnload = () => finalize("finish");
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onUnload);
    return () => { document.removeEventListener("visibilitychange", onHidden); window.removeEventListener("pagehide", onUnload); };
  }, [active, finalize, sendProgress]);

  const playerRef = useRef(null);
  const onEnded = useCallback(() => {
    acc.current.replays += 1;
    try { playerRef.current?.seekTo(0, true); playerRef.current?.playVideo(); } catch {}
  }, []);

  const like = useCallback((on = true) => {
    setLiked(on);
    beacon({ impressionId: item.impressionId, type: on ? "like" : "unlike" });
  }, [item.impressionId]);

  const share = async () => {
    const url = item.url;
    try {
      if (navigator.share) await navigator.share({ url, title: item.title });
      else { await navigator.clipboard.writeText(url); }
    } catch {}
    beacon({ impressionId: item.impressionId, type: "share" });
  };

  const hide = () => {
    acc.current.finalized = true;
    beacon({ impressionId: item.impressionId, type: "hide" }).then((r) => r && onFinished?.(r));
    onHide?.(item.impressionId);
  };

  // Tap: double = like with a burst; single = pause/play (YouTube only, since we control it).
  const onTap = (e) => {
    const now = Date.now();
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX ?? e.touches?.[0]?.clientX) - rect.left;
    const y = (e.clientY ?? e.touches?.[0]?.clientY) - rect.top;
    if (now - tapRef.current.last < 280) {
      clearTimeout(tapRef.current.timer);
      tapRef.current.last = 0;
      const id = now;
      setBursts((b) => [...b, { id, x, y }]);
      setTimeout(() => setBursts((b) => b.filter((k) => k.id !== id)), 900);
      if (!liked) like(true);
      if (navigator.vibrate) navigator.vibrate(12);
      return;
    }
    tapRef.current.last = now;
    tapRef.current.timer = setTimeout(() => { if (isYT) setUserPaused((p) => !p); }, 280);
  };

  const shown = item;
  const render = active || near;

  return (
    <section className="slide" data-impression={item.impressionId}>
      {shown.thumbnail && <div className="bgblur" style={{ backgroundImage: `url(${shown.thumbnail})` }} />}
      <div className="stage">
        {render ? (
          isYT
            ? <YouTubePlayer item={item} active={active} paused={paused || userPaused} soundOn={soundOn} onTick={onTick} onEnded={onEnded} playerRef={playerRef} />
            : <EmbedPlayer item={item} />
        ) : (
          <div className="poster"><div><div className="big">●</div>{shown.title}</div></div>
        )}
      </div>
      {isYT && <div className="tapzone" onPointerUp={onTap} />}
      <div className="shade top" />
      <div className="shade" />
      {bursts.map((b) => <div key={b.id} className="burst" style={{ left: b.x, top: b.y }}><Heart filled /></div>)}
      {userPaused && isYT && <div className="pausebadge"><Play /></div>}
      {showHint && <div className="hint"><span>▲</span>swipe up for the next one</div>}

      <div className="meta">
        <span className="reason">✦ {item.reason}</span>
        <div className="row"><span className={`srcpill ${item.source}`}>{item.source === "youtube" ? "Shorts" : item.source === "tiktok" ? "TikTok" : "Reels"}</span>{shown.creator && <span className="creator">{shown.creator}</span>}</div>
        {shown.title && <div className="title">{shown.title}</div>}
        {showInfo && <div className="tags">{(shown.tags || []).map((t) => <span key={t} className="tag">#{t}</span>)}</div>}
      </div>

      <div className="rail">
        <button className={`rbtn ${liked ? "liked" : ""}`} onClick={() => like(!liked)}><span className="ico"><Heart filled={liked} /></span>{liked ? "Liked" : "Like"}</button>
        <button className="rbtn" onClick={hide}><span className="ico"><EyeOff /></span>Not me</button>
        <button className="rbtn" onClick={share}><span className="ico"><Share /></span>Share</button>
        <button className="rbtn" onClick={() => setShowInfo((s) => !s)}><span className="ico"><Info /></span>Why</button>
      </div>
      <div className="progress"><div style={{ width: `${progress * 100}%` }} /></div>
    </section>
  );
}
