import React, { useCallback, useEffect, useRef, useState } from "react";
import YouTubePlayer from "./YouTubePlayer.jsx";
import TikTokPlayer from "./TikTokPlayer.jsx";
import EmbedPlayer from "./EmbedPlayer.jsx";
import Poster from "./Poster.jsx";
import { posterCandidates } from "../lib/posters.js";
import { beacon } from "../lib/api.js";
import { Heart, EyeOff, Share, Info, Play, Volume } from "./Icons.jsx";

const ASSUMED_EMBED_MS = 20000; // typical short clip when the platform hides duration
const PROGRESS_EVERY_MS = 2000;
const LABEL = { youtube: "Shorts", tiktok: "TikTok", instagram: "Reels" };

export default function VideoCard({ item, active, near, prewarm, soundOn, needsGesture, paused, next, onFinished, onHide, onWantSound, onSoundBlocked, onBroken, showHint }) {
  const kind = item.embedKind;
  const [liked, setLiked] = useState(false);
  const [bursts, setBursts] = useState([]);
  const [userPaused, setUserPaused] = useState(false);
  const [progress, setProgress] = useState(0);
  const [showInfo, setShowInfo] = useState(false);
  const [playing, setPlaying] = useState(false);         // first frame is on screen → poster fades out
  const [controllable, setControllable] = useState(kind === "youtube"); // we can pause/mute it ourselves
  // Where the browser only allows sound after a tap (iOS Safari), each clip starts muted and
  // a tap on it grants sound for that clip.
  const [granted, setGranted] = useState(false);
  const playerSound = (soundOn && !needsGesture) || granted;
  const wantsTap = soundOn && needsGesture && !granted;

  // Watch accounting lives in refs so it never triggers renders.
  const acc = useRef({ watchedMs: 0, durationMs: item.durationMs || 0, replays: 0, lastTick: 0, lastSent: 0, finalized: false, activatedAt: 0, clock: false, lastTime: 0 });
  const tapRef = useRef({ last: 0, timer: null });
  const playerRef = useRef(null);

  const sendProgress = useCallback((force = false) => {
    const a = acc.current;
    const t = Date.now();
    if (!force && t - a.lastSent < PROGRESS_EVERY_MS) return;
    a.lastSent = t;
    beacon({ impressionId: item.impressionId, type: "progress", watchedMs: Math.round(a.watchedMs), durationMs: Math.round(a.durationMs), replays: a.replays });
  }, [item.impressionId]);

  // Player clock (YouTube, TikTok): count only time that was actually playing.
  const onTick = useCallback(({ currentTime, duration, playing: isPlaying }) => {
    const a = acc.current;
    a.clock = true;
    if (duration > 0) a.durationMs = duration * 1000;
    const t = Date.now();
    if (isPlaying && a.lastTick) a.watchedMs += Math.min(1000, t - a.lastTick);
    a.lastTick = isPlaying ? t : 0;
    // A jump back to the start on a looping player is one replay.
    if (kind === "tiktok" && duration > 0 && a.lastTime > duration * 0.8 && currentTime < duration * 0.2) a.replays += 1;
    a.lastTime = currentTime;
    if (duration > 0) setProgress(Math.min(1, currentTime / duration));
    sendProgress();
  }, [sendProgress, kind]);

  // No player clock (Instagram, TikTok fallback): dwell time while active and visible.
  useEffect(() => {
    if (kind === "youtube" || !active || paused) return;
    let last = Date.now();
    const t = setInterval(() => {
      const a = acc.current;
      const nowT = Date.now();
      if (a.clock || document.visibilityState !== "visible") { last = nowT; return; }
      a.durationMs = a.durationMs || ASSUMED_EMBED_MS;
      a.watchedMs += nowT - last; last = nowT;
      setProgress(Math.min(1, a.watchedMs / a.durationMs));
      sendProgress();
    }, 250);
    return () => clearInterval(t);
  }, [kind, active, paused, sendProgress]);

  // Finalize when the card leaves the screen (or the page is hidden/unloaded).
  const finalize = useCallback((reason = "finish") => {
    const a = acc.current;
    if (a.finalized) return;
    a.finalized = true;
    beacon({ impressionId: item.impressionId, type: reason, watchedMs: Math.round(a.watchedMs), durationMs: Math.round(a.durationMs), replays: a.replays, skipped: a.watchedMs < 2500 })
      .then((r) => r && onFinished?.(r));
  }, [item.impressionId, onFinished]);

  useEffect(() => {
    if (active) { acc.current.activatedAt = Date.now(); acc.current.finalized = false; setUserPaused(false); return; }
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

  const onEnded = useCallback(() => {
    acc.current.replays += 1;
    try { playerRef.current?.seekTo(0, true); playerRef.current?.playVideo(); } catch {}
  }, []);
  const onPlaying = useCallback(() => setPlaying(true), []);

  // The platform says this clip cannot be played here (removed, private, embedding disabled).
  // It is retired from the catalog without counting as a skip, and the feed moves past it.
  const [broken, setBroken] = useState(false);
  const markBroken = useCallback((definitive = false) => {
    const a = acc.current;
    if (a.broken) return;
    a.broken = true; a.finalized = true;
    setBroken(true);
    beacon({ impressionId: item.impressionId, type: "broken", definitive: definitive === true });
    onBroken?.(item.impressionId);
  }, [item.impressionId, onBroken]);

  const like = useCallback((on = true) => {
    setLiked(on);
    beacon({ impressionId: item.impressionId, type: on ? "like" : "unlike" });
  }, [item.impressionId]);

  const share = async () => {
    try {
      if (navigator.share) await navigator.share({ url: item.url, title: item.title });
      else await navigator.clipboard.writeText(item.url);
    } catch {}
    beacon({ impressionId: item.impressionId, type: "share" });
  };

  const hide = () => {
    acc.current.finalized = true;
    beacon({ impressionId: item.impressionId, type: "hide" }).then((r) => r && onFinished?.(r));
    onHide?.(item.impressionId);
  };

  // Tap: double = like with a burst; single = pause/play, or grant sound if the browser held it back.
  const onTap = (e) => {
    const nowT = Date.now();
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const neverChoseSound = !soundOn && localStorage.getItem("axol_sound") === null;
    if (wantsTap || neverChoseSound) {
      // This tap is the gesture browsers require before a video may play with sound.
      setGranted(true);
      if (neverChoseSound) onWantSound?.();
      try { playerRef.current?.unMute?.(); playerRef.current?.setVolume?.(100); playerRef.current?.playVideo?.(); } catch {}
      tapRef.current.last = 0;
      return;
    }
    if (nowT - tapRef.current.last < 280) {
      clearTimeout(tapRef.current.timer);
      tapRef.current.last = 0;
      setBursts((b) => [...b, { id: nowT, x, y }]);
      setTimeout(() => setBursts((b) => b.filter((k) => k.id !== nowT)), 900);
      if (!liked) like(true);
      try { navigator.vibrate?.(12); } catch {}
      return;
    }
    tapRef.current.last = nowT;
    tapRef.current.timer = setTimeout(() => setUserPaused((p) => !p), 280);
  };

  const render = active || near;
  const bg = posterCandidates(item)[0];
  const isPaused = paused || userPaused;

  return (
    <section className={`slide ${active ? "is-active" : ""} ${playing ? "is-playing" : ""}`} data-impression={item.impressionId}>
      {bg && <div className="bgblur" style={{ backgroundImage: `url(${bg})` }} />}
      <div className="stage">
        {render && kind === "youtube" && (
          <YouTubePlayer item={item} active={active} paused={isPaused} prewarm={prewarm} soundOn={playerSound}
            onTick={onTick} onEnded={onEnded} onPlaying={onPlaying} onSoundBlocked={onSoundBlocked} onBroken={markBroken} playerRef={playerRef} />
        )}
        {render && kind === "tiktok" && (
          <TikTokPlayer item={item} active={active} paused={isPaused} soundOn={playerSound} onTick={onTick} onPlaying={onPlaying} onControllable={setControllable} onBroken={markBroken} />
        )}
        {render && kind === "instagram" && <EmbedPlayer item={item} onLoaded={onPlaying} />}
        <Poster item={item} />
        {!playing && <div className="shimmer" />}
      </div>
      {controllable && <div className="tapzone" onPointerUp={onTap} />}
      <div className="shade top" />
      <div className="shade" />
      {bursts.map((b) => <div key={b.id} className="burst" style={{ left: b.x, top: b.y }}><Heart filled /></div>)}
      {userPaused && controllable && <div className="pausebadge"><Play /></div>}
      {active && wantsTap && controllable && <div className="soundnudge"><Volume muted />Tap for sound</div>}
      {active && kind === "instagram" && playing && <div className="ignote">Tap the video to play it with sound</div>}
      {broken && <div className="brokennote">This clip isn't available any more. Skipping it…</div>}
      {showHint && !broken && <div className="hint"><span>▲</span>swipe up for the next one</div>}

      <div className="meta">
        <span className="reason">✦ {item.reason}</span>
        <div className="row"><span className={`srcpill ${item.source}`}>{LABEL[item.source] || item.source}</span>{item.creator && <span className="creator">{item.creator}</span>}</div>
        {item.title && <div className="title">{item.title}</div>}
        {showInfo && <div className="tags">{(item.tags || []).map((t) => <span key={t} className="tag">#{t}</span>)}</div>}
        {active && next && progress > 0.8 && <div className="upnext">Up next · {next.reason}<span>▲</span></div>}
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
