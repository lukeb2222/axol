import React, { useCallback, useEffect, useRef, useState } from "react";
import YouTubePlayer from "./YouTubePlayer.jsx";
import TikTokPlayer from "./TikTokPlayer.jsx";
import EmbedPlayer from "./EmbedPlayer.jsx";
import NativePlayer from "./NativePlayer.jsx";
import Poster from "./Poster.jsx";
import { posterCandidates } from "../lib/posters.js";
import { beacon } from "../lib/api.js";
import { Heart, EyeOff, Share, Info, Play, Volume } from "./Icons.jsx";

const ASSUMED_EMBED_MS = 20000; // typical short clip when the platform hides duration
const PROGRESS_EVERY_MS = 2000;
const LABEL = { youtube: "Shorts", tiktok: "TikTok", instagram: "Reels" };

export default function VideoCard({ item, active, near, prewarm, warm, soundOn, needsGesture, paused, next, onFinished, onHide, onWantSound, onSoundBlocked, onBroken, onAlive, onSteer, showHint }) {
  // axol's own player whenever the server holds the file; the platform's embed otherwise.
  const [nativeFailed, setNativeFailed] = useState(false);
  const kind = item.videoUrl && !nativeFailed ? "native" : item.embedKind;
  const [liked, setLiked] = useState(false);
  const [bursts, setBursts] = useState([]);
  const [userPaused, setUserPaused] = useState(false);
  const [progress, setProgress] = useState(0);
  const [showInfo, setShowInfo] = useState(false);
  // The short label and the Why panel read the same object, so they cannot disagree.
  const why = item.why || { label: item.reason, detail: "", clipTopics: [] };
  const topics = item.topics || [];
  const [steer, setSteer] = useState({ busy: "", done: {}, message: "" });
  const doSteer = async (topic, direction) => {
    if (!onSteer || steer.busy) return;
    setSteer((s) => ({ ...s, busy: `${direction}:${topic.tag}` }));
    try {
      const res = await onSteer(item, topic.tag, direction);
      setSteer((s) => ({ busy: "", done: { ...s.done, [topic.tag]: direction }, message: res?.message || "" }));
    } catch (e) {
      setSteer((s) => ({ ...s, busy: "", message: e.message || "That didn't go through. Try again." }));
    }
  };
  useEffect(() => { if (!active) setShowInfo(false); }, [active]);
  const [playing, setPlaying] = useState(false);         // first frame is on screen → poster fades out
  const [embedControllable, setControllable] = useState(false); // TikTok's player, once it answers
  const controllable = kind === "native" || kind === "youtube" || embedControllable;
  // Where the browser only allows sound after a tap (iOS Safari), each clip starts muted and
  // a tap on it grants sound for that clip.
  const [granted, setGranted] = useState(false);
  const playerSound = soundOn && (!needsGesture || granted);
  const wantsTap = soundOn && needsGesture && !granted;

  // Watch accounting lives in refs so it never triggers renders.
  const acc = useRef({ watchedMs: 0, durationMs: item.durationMs || 0, replays: 0, lastTick: 0, lastSent: 0, finalized: false, activatedAt: 0, clock: false, lastTime: 0 });
  const tapRef = useRef({ last: 0, timer: null });
  const playerRef = useRef(null);
  const videoRef = useRef(null);
  const onReplay = useCallback(() => { acc.current.replays += 1; }, []);

  const sendProgress = useCallback((force = false) => {
    const a = acc.current;
    const t = Date.now();
    if (!force && t - a.lastSent < PROGRESS_EVERY_MS) return;
    a.lastSent = t;
    beacon({ impressionId: item.impressionId, type: "progress", watchedMs: Math.round(a.watchedMs), durationMs: Math.round(a.durationMs), replays: a.replays, startMs: a.startMs || 0 });
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
    if (kind === "youtube" || kind === "native" || !active || paused) return;
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
    beacon({ impressionId: item.impressionId, type: reason, watchedMs: Math.round(a.watchedMs), durationMs: Math.round(a.durationMs), replays: a.replays, skipped: a.watchedMs < 2500, startMs: a.startMs || 0 })
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
  const onPlaying = useCallback(() => {
    setPlaying(true); onAlive?.(item.source);
    const a = acc.current;
    if (!a.startMs && a.activatedAt) a.startMs = Math.max(1, Date.now() - a.activatedAt);
  }, [onAlive, item.source]);
  // A clip still loading after a moment gets a spinner, so it never looks frozen.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!active || playing) return;
    const t = setTimeout(() => setSlow(true), 700);
    return () => clearTimeout(t);
  }, [active, playing]);

  // The platform says this clip cannot be played here (removed, private, embedding disabled).
  // It is retired from the catalog without counting as a skip, and the feed moves past it.
  const [broken, setBroken] = useState(false);
  const markBroken = useCallback((definitive = false) => {
    const a = acc.current;
    if (a.broken) return;
    a.broken = true; a.finalized = true;
    setBroken(true);
    beacon({ impressionId: item.impressionId, type: "broken", definitive: definitive === true });
    onBroken?.(item.impressionId, definitive === true);
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
    if (wantsTap) {
      // This tap is the gesture browsers require before a video may play with sound.
      setGranted(true);
      try { playerRef.current?.unMute?.(); playerRef.current?.setVolume?.(100); playerRef.current?.playVideo?.(); } catch {}
      // Unmuting inside the tap itself is what satisfies the browser's gesture rule.
      try { if (videoRef.current) { videoRef.current.muted = false; videoRef.current.play().catch(() => {}); } } catch {}
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

  // YouTube players are cheap to keep on both sides of the viewer. TikTok and Instagram players
  // load a whole page each and those platforms rate-limit, so they mount only for the clip on
  // screen and the one about to arrive.
  const render = kind === "youtube" || kind === "native" ? active || near || warm : active || prewarm;
  const bg = posterCandidates(item)[0];
  const isPaused = paused || userPaused;

  return (
    <section className={`slide ${active ? "is-active" : ""} ${playing ? "is-playing" : ""}`} data-impression={item.impressionId}>
      {bg && <div className="bgblur" style={{ backgroundImage: `url(${bg})` }} />}
      <div className="stage">
        {render && kind === "native" && (
          <NativePlayer item={item} active={active} warm={prewarm || warm} paused={isPaused} soundOn={playerSound} poster={bg}
            onTick={onTick} onPlaying={onPlaying} onReplay={onReplay} onSoundBlocked={onSoundBlocked}
            onFailed={() => { setNativeFailed(true); markBroken(false); }} videoRef={videoRef} />
        )}
        {render && kind === "youtube" && (
          <YouTubePlayer item={item} active={active} paused={isPaused} prewarm={prewarm || warm} soundOn={playerSound}
            onTick={onTick} onEnded={onEnded} onPlaying={onPlaying} onSoundBlocked={onSoundBlocked} onBroken={markBroken} playerRef={playerRef} />
        )}
        {render && kind === "tiktok" && (
          <TikTokPlayer item={item} active={active} paused={isPaused} soundOn={playerSound} onTick={onTick} onPlaying={onPlaying} onControllable={setControllable} onBroken={markBroken} />
        )}
        {render && kind === "instagram" && <EmbedPlayer item={item} onLoaded={onPlaying} onBroken={markBroken} />}
        <Poster item={item} />
        {!playing && <div className="shimmer" />}
        {slow && !playing && !broken && <div className="loadspin"><span className="spin light" /></div>}
      </div>
      {controllable && <div className="tapzone" onPointerUp={onTap} />}
      <div className="shade top" />
      <div className="shade" />
      {bursts.map((b) => <div key={b.id} className="burst" style={{ left: b.x, top: b.y }}><Heart filled /></div>)}
      {userPaused && controllable && <div className="pausebadge"><Play /></div>}
      {active && wantsTap && controllable && <div className="soundnudge"><Volume muted />Tap for sound</div>}
      {active && kind === "instagram" && playing && <div className="ignote">Tap the video to play it with sound</div>}
      {broken && active && <div className="brokennote">{LABEL[item.source]} couldn't load this clip. Skipping it…</div>}
      {showHint && !broken && <div className="hint"><span>▲</span>swipe up for the next one</div>}

      <div className="meta">
        <span className="reason">✦ {why.label}</span>
        <div className="row"><span className={`srcpill ${item.source}`}>{LABEL[item.source] || item.source}</span>{item.creator && <span className="creator">{item.creator}</span>}</div>
        {item.title && <div className="title">{item.title}</div>}
        {showInfo && (
          <div className="whypanel" role="dialog" aria-label="Why this clip">
            <div className="why-head">Why this clip</div>
            <div className="why-label">{why.label}</div>
            {why.detail && <p className="why-detail">{why.detail}</p>}
            {topics.length > 0 && onSteer && (
              <>
                <div className="why-head">Steer your next clips</div>
                {topics.map((t) => (
                  <div className="steer-row" key={t.tag}>
                    <button className={`steer more ${steer.done[t.tag] === "more" ? "on" : ""}`} disabled={!!steer.busy} onClick={() => doSteer(t, "more")}>
                      {steer.busy === `more:${t.tag}` ? <span className="spin light" /> : "＋"} More {t.label}
                    </button>
                    <button className={`steer less ${steer.done[t.tag] === "less" ? "on" : ""}`} disabled={!!steer.busy} onClick={() => doSteer(t, "less")}>
                      {steer.busy === `less:${t.tag}` ? <span className="spin light" /> : "−"} Less {t.label}
                    </button>
                  </div>
                ))}
              </>
            )}
            {steer.message && <div className="steer-msg" role="status">{steer.message}</div>}
          </div>
        )}
        {/* The teaser names the next clip's subject. It never borrows the next clip's "Because…"
            line, which would read as a claim about the clip on screen. */}
        {active && next && progress > 0.8 && !showInfo && <div className="upnext">Up next · {next.topics?.[0]?.label || LABEL[next.source] || "another clip"}<span>▲</span></div>}
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
