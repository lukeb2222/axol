import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { sound } from "../lib/youtube.js";
import { preloadPoster } from "../lib/posters.js";
import VideoCard from "./VideoCard.jsx";
import Toasts from "./Toasts.jsx";
import GestureFlash from "./GestureFlash.jsx";
import GestureHud from "./GestureHud.jsx";
import { useHandsFree } from "../lib/useHandsFree.js";
import { rememberUndo, undoTarget } from "../lib/handsFreeUndo.js";
import { playerCommands, SHORTCUTS } from "../lib/playerCommands.js";
import { api, beacon } from "../lib/api.js";
import { Volume, Back } from "./Icons.jsx";

const PREFETCH_AT = 3;
const GLIDE_MS = 520;
const easeOutQuart = (t) => 1 - Math.pow(1 - t, 4);

/**
 * The vertical reel player. Touch uses native snap scrolling (it has the platform's own momentum);
 * wheel and keyboard use a custom eased glide so one gesture always lands exactly one clip on.
 * The clip under the viewport's midpoint is active; its neighbours are mounted and the next one is
 * buffered ahead of time, so a swipe lands on moving video rather than a spinner.
 */
export default function ReelScroller({ items, onNeedMore, onRemove, onSteer, paused, startIndex = 0, overlay, onClose, title, tail, right, onActiveChange }) {
  const [active, setActive] = useState(startIndex);
  const [help, setHelp] = useState(false);
  useEffect(() => { onActiveChange?.(active); }, [active, onActiveChange]);

  const [soundOn, setSoundOn] = useState(sound.on);
  // Browsers refuse to start video with sound until the viewer has interacted with the page.
  // Until then clips play muted; the first tap, click or key press anywhere turns sound on.
  // (If a browser blocks sound again later, as iOS Safari can, this flips back until the next tap.)
  const [needsGesture, setNeedsGesture] = useState(() => (navigator.userActivation ? !navigator.userActivation.hasBeenActive : false));
  useEffect(() => {
    const unlock = () => setNeedsGesture(false);
    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("keydown", unlock, true);
    return () => { window.removeEventListener("pointerdown", unlock, true); window.removeEventListener("keydown", unlock, true); };
  }, []);
  const [toasts, setToasts] = useState([]);
  const [tuned, setTuned] = useState(0);
  const [hint, setHint] = useState(() => !overlay && !localStorage.getItem("axol_hinted"));
  const feedRef = useRef(null);
  const live = useRef({});
  live.current = { active, paused, count: items.length, items, locked: false };
  const glide = useRef({ running: false, raf: 0, lockUntil: 0, acc: 0, accTimer: 0 });
  const health = useRef({});               // consecutive player failures per platform
  const [tripped, setTripped] = useState({}); // platform -> time until which it is rested
  const watched = useRef(0);
  // A promoted clip the viewer has not watched through yet holds the feed until it has played.
  const [released, setReleased] = useState({});
  const [nudge, setNudge] = useState(0);
  const [undo, setUndo] = useState(null);
  const [flash, setFlash] = useState(null);
  const [laughToday, setLaughToday] = useState(0);
  const hudCanvas = useRef(null);
  const laughed = useRef(new Set());
  const cur = items[active];
  const locked = !overlay && !!cur?.promo?.mustWatch && !released[cur.impressionId];
  const release = useCallback((impressionId) => setReleased((r) => (r[impressionId] ? r : { ...r, [impressionId]: true })), []);

  // Start on the requested clip (search results open mid-list).
  useLayoutEffect(() => {
    const root = feedRef.current;
    if (root && startIndex) root.scrollTop = startIndex * root.clientHeight;
  }, [startIndex]);

  // The slide under the midpoint of the viewport is the active one.
  useEffect(() => {
    const root = feedRef.current;
    if (!root) return;
    let ticking = false;
    const measure = () => {
      ticking = false;
      if (!root.clientHeight) return; // hidden behind another tab: nothing to measure
      if (glide.current.running) return; // a glide already activated its destination
      // A held promoted clip stays put however the scroll was attempted.
      if (live.current.locked && root.scrollTop > live.current.active * root.clientHeight) { root.scrollTop = live.current.active * root.clientHeight; return; }
      // Hand over to the incoming clip once the swipe is 30% of the way there, so it is already
      // playing by the time it settles.
      const pos = root.scrollTop / root.clientHeight, cur = live.current.active;
      let idx = cur;
      if (pos >= cur + 0.3) idx = Math.floor(pos + 0.7);
      else if (pos <= cur - 0.3) idx = Math.ceil(pos - 0.7);
      idx = Math.min(Math.max(0, live.current.count - 1), Math.max(0, idx));
      if (idx !== cur) {
        setActive(idx);
        if (idx > 0) { setHint(false); localStorage.setItem("axol_hinted", "1"); }
        try { navigator.vibrate?.(8); } catch {}
      }
    };
    const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(measure); } };
    const onResize = () => { root.scrollTop = live.current.active * root.clientHeight; };
    root.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    return () => { root.removeEventListener("scroll", onScroll); window.removeEventListener("resize", onResize); };
  }, []);

  live.current.locked = locked;
  const goTo = useCallback((idx, origin = "user") => {
    const root = feedRef.current;
    if (!root) return false;
    if (live.current.locked && idx > live.current.active) { setNudge((n) => n + 1); return false; }
    const to = Math.max(0, Math.min(live.current.count - 1, idx));
    const target = to * root.clientHeight;
    const start = root.scrollTop, dist = target - start;
    if (Math.abs(dist) < 2) return false;
    if (origin !== "gesture" && origin !== "undo") setUndo(null);
    setActive(to); // wheel and keyboard know their destination: start that clip immediately
    const g = glide.current;
    cancelAnimationFrame(g.raf);
    g.running = true;
    root.style.scrollSnapType = "none"; // snapping would fight the animation
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / GLIDE_MS);
      root.scrollTop = start + dist * easeOutQuart(k);
      if (k < 1) g.raf = requestAnimationFrame(step);
      else { root.scrollTop = target; root.style.scrollSnapType = ""; g.running = false; }
    };
    g.raf = requestAnimationFrame(step);
    return true;
  }, []);

  // Wheel / trackpad: one deliberate gesture = one clip, however much inertia follows it.
  useEffect(() => {
    const root = feedRef.current;
    if (!root) return;
    const onWheel = (e) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      const g = glide.current, t = performance.now();
      if (g.running || t < g.lockUntil) return;
      g.acc += e.deltaY;
      clearTimeout(g.accTimer);
      g.accTimer = setTimeout(() => { g.acc = 0; }, 160);
      if (Math.abs(g.acc) > 40) {
        const dir = Math.sign(g.acc);
        g.acc = 0;
        g.lockUntil = t + GLIDE_MS + 220;
        goTo(live.current.active + dir);
      }
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [goTo]);

  // Optional hands-free control: nods and a stuck-out tongue move on, a tilt goes back, a wink
  // likes, raised brows pause, and a laugh saves the clip. A promoted clip that is still being
  // held stays held, just as it would for a swipe.
  const flashGesture = useCallback((kind, label) => {
    const token = { kind, label, n: Date.now() };
    setFlash(token);
    setTimeout(() => setFlash((f) => (f && f.n === token.n ? null : f)), 900);
  }, []);
  useEffect(() => {
    api.laughs().then((s) => { if (Number.isFinite(s?.today)) setLaughToday(s.today); }).catch(() => {});
  }, []);
  const handsFree = useHandsFree({
    active: !paused && items.length > 0,
    onFrame: (frame) => {
      const c = hudCanvas.current;
      if (!c) return;
      if (c.width !== frame.width || c.height !== frame.height) { c.width = frame.width; c.height = frame.height; }
      c.getContext("2d").drawImage(frame, 0, 0);
    },
    onGesture: (kind) => {
      const from = live.current.active;
      const item = live.current.items[from];
      if (kind === "nod" || kind === "tongue") {
        if (goTo(from + 1, "gesture")) { setUndo(rememberUndo(from, from + 1)); flashGesture(kind); }
        return;
      }
      if (kind === "tilt") {
        if (goTo(from - 1, "gesture")) { setUndo(rememberUndo(from, from - 1)); flashGesture("tilt"); }
        return;
      }
      if (kind === "wink") {
        playerCommands().gestureLike?.();
        flashGesture("wink");
        return;
      }
      if (kind === "brow") {
        const nowPaused = playerCommands().togglePause?.();
        flashGesture(nowPaused ? "brow" : "brow-play");
        return;
      }
      if (kind === "laugh" && item && !laughed.current.has(item.impressionId)) {
        laughed.current.add(item.impressionId);
        beacon({ impressionId: item.impressionId, type: "laugh", tz: -new Date().getTimezoneOffset() })
          .then((r) => { if (Number.isFinite(r?.today)) setLaughToday(r.today); else setLaughToday((n) => n + 1); });
        flashGesture("laugh");
      }
    },
  });
  useEffect(() => {
    if (!undo) return;
    const ms = undo.until - Date.now();
    if (ms <= 0) { setUndo(null); return; }
    const id = setTimeout(() => setUndo(null), ms);
    return () => clearTimeout(id);
  }, [undo]);
  const HF_LABEL = { starting: "Starting camera…", on: "Hands-free on", noface: "Can't see your face", dark: "Too dark for the camera", stalled: "Camera isn't sending video", denied: "Camera blocked", nocamera: "No camera found", error: "Hands-free unavailable", off: "Hands-free on" };

  const toggleSound = useCallback(() => { sound.on = !sound.on; setSoundOn(sound.on); }, []);
  const wantSound = useCallback(() => { sound.on = true; setSoundOn(true); }, []);
  const onShared = useCallback(({ copied } = {}) => {
    if (copied) setToasts((t) => [...t, { id: Date.now(), text: "Link copied" }].slice(-3));
  }, []);


  useEffect(() => {
    const onKey = (e) => {
      if (live.current.paused || e.target.closest?.("textarea,input")) return;
      const k = e.key;
      if (k === "?" || (k === "/" && e.shiftKey)) { e.preventDefault(); setHelp((h) => !h); return; }
      if (k === "Escape") { e.preventDefault(); if (help) { setHelp(false); return; } onClose?.(); return; }
      if (help) return;
      if (k === " ") { e.preventDefault(); playerCommands()?.pause?.(); return; }
      if (["ArrowDown", "PageDown", "j"].includes(k)) { e.preventDefault(); goTo(live.current.active + 1); }
      else if (["ArrowUp", "PageUp", "k"].includes(k)) { e.preventDefault(); goTo(live.current.active - 1); }
      else if (k.toLowerCase() === "m") toggleSound();
      else if (k.toLowerCase() === "l") { e.preventDefault(); playerCommands()?.like?.(); }
      else if (k.toLowerCase() === "c") { e.preventDefault(); playerCommands()?.share?.(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goTo, toggleSound, onClose, help]);

  // Keep the feed ahead of the viewer: more clips, and the next posters already decoded.
  useEffect(() => {
    if (items.length && active >= items.length - PREFETCH_AT) onNeedMore?.();
    for (let i = 1; i <= 3; i++) if (items[active + i]) preloadPoster(items[active + i]);
  }, [active, items, onNeedMore]);

  useEffect(() => {
    for (const ahead of [items[active + 1], items[active + 2]]) {
      if (ahead && tripped[ahead.source] > Date.now()) { onRemove?.(ahead.impressionId); return; }
    }
  }, [active, items, tripped, onRemove]);

  const pushToast = useCallback((t) => {
    const id = Math.random();
    setToasts((ts) => [...ts.slice(-2), { id, ...t }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), t.big ? 5200 : 3300);
  }, []);

  const onFinished = useCallback((r) => {
    watched.current += 1;
    let didTune = false;
    if (r?.learned?.deltas?.length) {
      const deltas = r.learned.deltas.filter((d) => Math.abs(d.delta) >= 0.02).slice(0, 3);
      if (deltas.length) { pushToast({ deltas }); didTune = true; }
    }
    if (didTune) setTuned((n) => n + 1);
    if (r?.synth?.insight) pushToast({ big: true, text: r.synth.insight });
    else if ([10, 25, 50, 100].includes(watched.current)) pushToast({ big: true, text: `${watched.current} clips in. Your feed is sharper than when you started.` });
  }, [pushToast]);

  const onSoundBlocked = useCallback(() => setNeedsGesture(true), []);

  // "More …" / "Less …" from a clip's Why panel. The clips loaded after that clip are sent along
  // so the server can re-plan exactly those; the clip itself keeps playing untouched.
  const steer = useCallback(async (item, tag, direction) => {
    const list = live.current.items;
    const idx = list.findIndex((i) => i.impressionId === item.impressionId);
    const res = await onSteer({ impressionId: item.impressionId, tag, direction, queue: idx < 0 ? [] : list.slice(idx + 1).map((i) => i.impressionId) });
    if (res?.message) pushToast({ big: true, text: res.message });
    return res;
  }, [onSteer, pushToast]);

  // An unplayable clip ahead of the viewer is dropped before they reach it; one they are
  // already on is skipped after a moment so they can see why.
  // If one platform's player fails three times running (it is rate-limiting or blocked on this
  // network), stop walking the viewer into its clips for a few minutes instead of skipping each
  // one in front of them. Those clips stay unwatched, so they come back later.
  const onAlive = useCallback((source) => { health.current[source] = 0; }, []);
  const onBroken = useCallback((impressionId, definitive) => {
    const idx = live.current.items.findIndex((i) => i.impressionId === impressionId);
    if (idx < 0) return;
    release(impressionId); // a clip that cannot play never holds the feed
    live.current.locked = false;
    const source = live.current.items[idx].source;
    if (!definitive) {
      health.current[source] = (health.current[source] || 0) + 1;
      if (health.current[source] >= 3) {
        health.current[source] = 0;
        setTripped((t) => ({ ...t, [source]: Date.now() + 5 * 60e3 }));
      }
    }
    if (idx > live.current.active) { onRemove?.(impressionId); return; }
    if (idx === live.current.active) setTimeout(() => { if (live.current.items[live.current.active]?.impressionId === impressionId) goTo(live.current.active + 1); }, 1100);
  }, [goTo, onRemove, release]);

  // Touch scrolling is native, so the hold is applied to the scroller itself; a swipe while held
  // pulses the countdown instead.
  const touchY = useRef(null);
  const onTouchStart = (e) => { touchY.current = e.touches[0]?.clientY ?? null; };
  const onTouchEnd = (e) => {
    const y = e.changedTouches[0]?.clientY;
    if (locked && touchY.current != null && y != null && touchY.current - y > 40) setNudge((n) => n + 1);
    touchY.current = null;
  };

  return (
    <div className={`reels ${overlay ? "overlay" : ""}`}>
      <div className={`feed ${locked ? "held" : ""}`} ref={feedRef} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        {items.map((item, idx) => (
          <div key={item.impressionId} className="slide-wrap">
            <VideoCard item={item} active={idx === active && !paused} near={Math.abs(idx - active) === 1} prewarm={idx === active + 1 && !paused} warm={idx === active + 2 && !paused}
              soundOn={soundOn} needsGesture={needsGesture} paused={paused} next={items[idx + 1]}
              onFinished={onFinished} onHide={onRemove} onWantSound={wantSound} onSoundBlocked={onSoundBlocked} onBroken={onBroken} onAlive={onAlive} onSteer={onSteer ? steer : undefined} showHint={hint && idx === 0 && !locked}
              held={locked && idx === active} nudge={nudge} onPromoDone={release} onShared={onShared} />
          </div>
        ))}
        {/* The loading card is deliberately not a snap point: browsers keep following whichever
            element they are snapped to, so snapping to it would drag the viewer along as new
            clips are inserted above it. */}
        {tail && <div className="slide-wrap tail">{tail}</div>}
      </div>
      <div className="topbar">
        <div className="row">
          {onClose && <button className="pill" onClick={onClose} aria-label="Back"><Back /></button>}
          <button className={`pill ${soundOn ? "hot" : ""}`} onClick={toggleSound}><Volume muted={!soundOn || needsGesture} />{!soundOn ? "Sound off" : needsGesture ? "Tap for sound" : "Sound on"}</button>
          {handsFree.wanted && (
            <button className={`pill hf ${handsFree.paused ? "" : handsFree.status === "on" ? "hot" : "warn"}`} onClick={handsFree.togglePause} data-testid="hf-pill" data-status={handsFree.paused ? "paused" : handsFree.status} data-count={handsFree.gesture.n} data-last={handsFree.gesture.kind}
              title={handsFree.paused ? "Turn hands-free scrolling back on" : "Pause hands-free scrolling (turns the camera off)"}>
              <span className="hfdot" key={handsFree.gesture.n} data-fired={handsFree.gesture.n > 0 ? handsFree.gesture.kind : ""} />
              {handsFree.paused ? "Hands-free paused" : HF_LABEL[handsFree.status] || "Hands-free on"}
            </button>
          )}
          {undoTarget(undo) != null && (
            <button className="pill hot" data-testid="hf-undo" onClick={() => { const to = undoTarget(undo); setUndo(null); if (to != null) goTo(to, "undo"); }}>
              Undo
            </button>
          )}
        </div>
        <div className="row">
          {title && <span className="pill">{title}</span>}
          {tuned > 0 && <span className="pill hot" key={tuned}>✦ tuned ×{tuned}</span>}
          {right}
          {!matchMedia("(pointer: coarse)").matches && (
            <button className="pill" onClick={() => setHelp(true)} data-testid="keys-help" title="Keyboard shortcuts">Keys</button>
          )}
        </div>
      </div>
      {help && (
        <div className="keyhelp" role="dialog" aria-label="Keyboard shortcuts" data-testid="keyhelp" onClick={() => setHelp(false)}>
          <div className="keyhelp-card" onClick={(e) => e.stopPropagation()}>
            <div className="tiny" style={{ marginBottom: 8 }}>KEYBOARD</div>
            <h2 style={{ margin: "0 0 12px" }}>Shortcuts</h2>
            <ul className="keylist">
              {SHORTCUTS.map((s) => <li key={s.keys}><kbd>{s.keys}</kbd><span>{s.action}</span></li>)}
            </ul>
            <button className="btn sm ghost" onClick={() => setHelp(false)}>Close</button>
          </div>
        </div>
      )}
      {handsFree.hud && <GestureHud canvasRef={hudCanvas} status={handsFree.status} gesture={handsFree.gesture} />}
      {flash && <GestureFlash kind={flash.kind} label={flash.label} today={laughToday} />}
      <Toasts items={toasts} />

    </div>
  );
}
