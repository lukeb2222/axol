import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { sound } from "../lib/youtube.js";
import { preloadPoster } from "../lib/posters.js";
import VideoCard from "./VideoCard.jsx";
import Toasts from "./Toasts.jsx";
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
export default function ReelScroller({ items, onNeedMore, onRemove, paused, startIndex = 0, overlay, onClose, title, tail, right }) {
  const [active, setActive] = useState(startIndex);
  const [soundOn, setSoundOn] = useState(sound.on);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [tuned, setTuned] = useState(0);
  const [hint, setHint] = useState(() => !overlay && !localStorage.getItem("axol_hinted"));
  const feedRef = useRef(null);
  const live = useRef({});
  live.current = { active, paused, count: items.length, items };
  const glide = useRef({ running: false, raf: 0, lockUntil: 0, acc: 0, accTimer: 0 });
  const health = useRef({});               // consecutive player failures per platform
  const [tripped, setTripped] = useState({}); // platform -> time until which it is rested
  const watched = useRef(0);

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

  const goTo = useCallback((idx) => {
    const root = feedRef.current;
    if (!root) return;
    const to = Math.max(0, Math.min(live.current.count - 1, idx));
    const target = to * root.clientHeight;
    const start = root.scrollTop, dist = target - start;
    if (Math.abs(dist) < 2) return;
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

  const toggleSound = useCallback(() => { sound.on = !sound.on; setSoundOn(sound.on); }, []);
  const wantSound = useCallback(() => { sound.on = true; setSoundOn(true); }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (live.current.paused || e.target.closest?.("textarea,input")) return;
      if (["ArrowDown", "PageDown", " ", "j"].includes(e.key)) { e.preventDefault(); goTo(live.current.active + 1); }
      else if (["ArrowUp", "PageUp", "k"].includes(e.key)) { e.preventDefault(); goTo(live.current.active - 1); }
      else if (e.key.toLowerCase() === "m") toggleSound();
      else if (e.key === "Escape" && onClose) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goTo, toggleSound, onClose]);

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

  // An unplayable clip ahead of the viewer is dropped before they reach it; one they are
  // already on is skipped after a moment so they can see why.
  // If one platform's player fails three times running (it is rate-limiting or blocked on this
  // network), stop walking the viewer into its clips for a few minutes instead of skipping each
  // one in front of them. Those clips stay unwatched, so they come back later.
  const onAlive = useCallback((source) => { health.current[source] = 0; }, []);
  const onBroken = useCallback((impressionId, definitive) => {
    const idx = live.current.items.findIndex((i) => i.impressionId === impressionId);
    if (idx < 0) return;
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
  }, [goTo, onRemove]);

  return (
    <div className={`reels ${overlay ? "overlay" : ""}`}>
      <div className="feed" ref={feedRef}>
        {items.map((item, idx) => (
          <div key={item.impressionId} className="slide-wrap">
            <VideoCard item={item} active={idx === active && !paused} near={Math.abs(idx - active) === 1} prewarm={idx === active + 1 && !paused} warm={idx === active + 2 && !paused}
              soundOn={soundOn} needsGesture={needsGesture} paused={paused} next={items[idx + 1]}
              onFinished={onFinished} onHide={onRemove} onWantSound={wantSound} onSoundBlocked={onSoundBlocked} onBroken={onBroken} onAlive={onAlive} showHint={hint && idx === 0} />
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
          <button className={`pill ${soundOn ? "hot" : ""}`} onClick={toggleSound}><Volume muted={!soundOn} />{soundOn ? "Sound on" : "Tap for sound"}</button>
        </div>
        <div className="row">
          {title && <span className="pill">{title}</span>}
          {tuned > 0 && <span className="pill hot" key={tuned}>✦ tuned ×{tuned}</span>}
          {right}
        </div>
      </div>
      <Toasts items={toasts} />
    </div>
  );
}
