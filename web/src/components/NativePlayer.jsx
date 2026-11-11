import React, { useEffect, useRef } from "react";

/**
 * axol's own player, used whenever the server holds the clip's file. A plain <video> element:
 * it buffers before the viewer arrives (`warm`), starts on the same frame the swipe lands,
 * loops, obeys the sound button exactly, and reports true playback time.
 */
export default function NativePlayer({ item, active, warm, soundOn, paused, poster, onTick, onPlaying, onReplay, onSoundBlocked, onFailed, videoRef }) {
  const ref = useRef(null);
  const live = useRef({});
  live.current = { active, soundOn, paused, onTick, onPlaying, onReplay, onSoundBlocked, onFailed };
  const lastTime = useRef(0);

  useEffect(() => { if (videoRef) videoRef.current = ref.current; }, [videoRef]);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.muted = !soundOn;
    if (active && !paused) {
      const p = v.play();
      if (p?.catch) p.catch((e) => {
        // Browsers that need a tap before sound: start muted and let the card ask for the tap.
        if (e?.name === "NotAllowedError" && !v.muted) { v.muted = true; v.play().catch(() => {}); live.current.onSoundBlocked?.(true); }
      });
    } else {
      v.pause();
      if (!active && v.currentTime > 0) { try { v.currentTime = 0; } catch {} }
    }
  }, [active, paused, soundOn]);

  const onTime = () => {
    const v = ref.current, s = live.current;
    if (!v || !s.active) return;
    // The element loops by itself; a jump back to the start is one replay.
    if (lastTime.current > v.duration * 0.8 && v.currentTime < v.duration * 0.2) s.onReplay?.();
    lastTime.current = v.currentTime;
    s.onTick?.({ currentTime: v.currentTime, duration: v.duration || 0, playing: !v.paused });
  };

  return (
    <div className="frame native">
      <video ref={ref} src={item.videoUrl} poster={poster || undefined} playsInline loop muted={!soundOn}
        preload={active || warm ? "auto" : "metadata"} disablePictureInPicture controlsList="nodownload noplaybackrate"
        onPlaying={() => { if (live.current.active) live.current.onPlaying?.(); }}
        onTimeUpdate={onTime}
        onError={() => live.current.onFailed?.()} />
    </div>
  );
}
