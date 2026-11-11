import React, { useEffect, useRef, useState } from "react";

/**
 * TikTok's official embed player (tiktok.com/player/v1), driven over postMessage so the app
 * can autoplay, pause, mute, loop and read real playback time.
 *
 * The iframe stays invisible until the player announces itself. TikTok sometimes answers with an
 * empty page (rate limiting, a removed clip), and a browser paints an empty page as a solid white
 * block inside a dark site. If no announcement arrives in time the clip is reported as unavailable
 * and the feed moves past it; the white page is never shown.
 */
const ORIGIN = "https://www.tiktok.com";
const PARAMS = "loop=1&controls=0&progress_bar=0&play_button=0&volume_control=0&fullscreen_button=0&timestamp=0&music_info=0&description=0&rel=0&native_context_menu=0&closed_caption=0";
const HANDSHAKE_MS = 7000;

export default function TikTokPlayer({ item, active, soundOn, paused, onTick, onPlaying, onControllable, onBroken }) {
  const ref = useRef(null);
  const [alive, setAlive] = useState(false);
  const aliveRef = useRef(false);
  const live = useRef({});
  live.current = { active, soundOn, paused, onTick, onPlaying, onControllable, onBroken };
  const last = useRef({ t: 0, d: 0, playing: false, announced: false });

  const send = (type, value) => {
    try { ref.current?.contentWindow?.postMessage({ type, value, "x-tiktok-player": true }, ORIGIN); } catch {}
  };
  const apply = () => {
    if (!aliveRef.current) return;
    const s = live.current;
    send(s.soundOn ? "unMute" : "mute");
    send(s.active && !s.paused ? "play" : "pause");
  };
  const announcePlaying = () => {
    if (last.current.announced || !live.current.active) return;
    last.current.announced = true;
    live.current.onPlaying?.();
  };

  useEffect(() => {
    const onMsg = (e) => {
      if (e.origin !== ORIGIN || e.source !== ref.current?.contentWindow) return;
      let m = e.data;
      if (typeof m === "string") { try { m = JSON.parse(m); } catch { return; } }
      if (!m || !m["x-tiktok-player"]) return;
      const s = live.current;
      if (m.type === "onPlayerError" || m.type === "onError") { s.onBroken?.(false); return; }
      if (!aliveRef.current) { aliveRef.current = true; setAlive(true); s.onControllable?.(true); apply(); }
      if (m.type === "onStateChange") {
        last.current.playing = m.value === 1;
        if (m.value === 1 && !s.active) send("pause");
        if (m.value === 1) announcePlaying();
      }
      if (m.type === "onCurrentTime" && m.value) {
        const moved = (m.value.currentTime || 0) > last.current.t;
        last.current.t = m.value.currentTime || 0; last.current.d = m.value.duration || 0;
        if (moved) { last.current.playing = true; announcePlaying(); }
        if (s.active) s.onTick?.({ currentTime: last.current.t, duration: last.current.d, playing: last.current.playing });
      }
    };
    window.addEventListener("message", onMsg);
    const t = setTimeout(() => { if (!aliveRef.current) live.current.onBroken?.(false); }, HANDSHAKE_MS);
    return () => { window.removeEventListener("message", onMsg); clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  useEffect(() => {
    apply();
    if (active) last.current.announced = false;
    // A live player that has not reported "playing" (autoplay held back) is still safe to show.
    if (!active || !alive) return;
    const t = setTimeout(announcePlaying, 2500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, paused, soundOn, alive]);

  // Keep the watch clock ticking between the player's own time reports.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      if (aliveRef.current && last.current.d) live.current.onTick?.({ currentTime: last.current.t, duration: last.current.d, playing: last.current.playing });
    }, 250);
    return () => clearInterval(t);
  }, [active]);

  return (
    <div className={`frame ${alive ? "" : "wait"}`}>
      <iframe ref={ref} title={item.title || "TikTok"} src={`${ORIGIN}/player/v1/${item.externalId}?autoplay=0&${PARAMS}`}
        allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowFullScreen />
    </div>
  );
}
