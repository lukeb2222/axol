import React, { useEffect, useRef, useState } from "react";

/**
 * TikTok's official embed player (tiktok.com/player/v1), driven over postMessage so the app
 * can autoplay, pause, mute, loop and read real playback time. If the player never reports
 * ready, it falls back to the classic embed, where the card tracks dwell time instead.
 */
const ORIGIN = "https://www.tiktok.com";
const PARAMS = "loop=1&controls=0&progress_bar=0&play_button=0&volume_control=0&fullscreen_button=0&timestamp=0&music_info=0&description=0&rel=0&native_context_menu=0&closed_caption=0";

export default function TikTokPlayer({ item, active, soundOn, paused, onTick, onPlaying, onControllable, onBroken }) {
  const ref = useRef(null);
  const ready = useRef(false);
  const [fallback, setFallback] = useState(false);
  const live = useRef({});
  live.current = { active, soundOn, paused, onTick, onPlaying, onControllable, onBroken };
  const last = useRef({ t: 0, d: 0, playing: false });

  const send = (type, value) => {
    try { ref.current?.contentWindow?.postMessage({ type, value, "x-tiktok-player": true }, ORIGIN); } catch {}
  };
  const apply = () => {
    if (!ready.current) return;
    const s = live.current;
    send(s.soundOn ? "unMute" : "mute");
    send(s.active && !s.paused ? "play" : "pause");
  };

  useEffect(() => {
    const onMsg = (e) => {
      if (e.origin !== ORIGIN || e.source !== ref.current?.contentWindow) return;
      let m = e.data;
      if (typeof m === "string") { try { m = JSON.parse(m); } catch { return; } }
      if (!m || !m["x-tiktok-player"]) return;
      const s = live.current;
      // The player answered, so it is alive: no need for the classic-embed fallback.
      ready.current = ready.current || m.type === "onPlayerError";
      if (m.type === "onPlayerError") { s.onBroken?.(); return; }
      if (m.type === "onPlayerReady") { ready.current = true; s.onControllable?.(true); apply(); }
      if (m.type === "onStateChange") {
        last.current.playing = m.value === 1;
        if (m.value === 1 && s.active) s.onPlaying?.();
        if (m.value === 1 && !s.active) send("pause");
      }
      if (m.type === "onCurrentTime" && m.value) {
        last.current.t = m.value.currentTime || 0; last.current.d = m.value.duration || 0;
        if (s.active) s.onTick?.({ currentTime: last.current.t, duration: last.current.d, playing: last.current.playing });
      }
    };
    window.addEventListener("message", onMsg);
    // No handshake within a few seconds means this player build is not controllable here.
    const t = setTimeout(() => { if (!ready.current) setFallback(true); }, 7000);
    return () => { window.removeEventListener("message", onMsg); clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  useEffect(apply, [active, paused, soundOn]);

  // Keep the watch clock ticking between the player's own time reports.
  useEffect(() => {
    if (!active || fallback) return;
    const t = setInterval(() => {
      if (ready.current && last.current.d) live.current.onTick?.({ currentTime: last.current.t, duration: last.current.d, playing: last.current.playing });
    }, 250);
    return () => clearInterval(t);
  }, [active, fallback]);

  const src = fallback
    ? `${ORIGIN}/embed/v2/${item.externalId}?lang=en-US`
    : `${ORIGIN}/player/v1/${item.externalId}?autoplay=0&${PARAMS}`;
  return (
    <div className="frame">
      <iframe ref={ref} key={src} title={item.title || "TikTok"} src={src} allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowFullScreen
        onLoad={() => { if (fallback) live.current.onPlaying?.(); }} />
    </div>
  );
}
