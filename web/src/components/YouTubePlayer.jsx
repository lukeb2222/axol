import React, { useEffect, useRef } from "react";
import { loadYT } from "../lib/youtube.js";

/**
 * Official YouTube IFrame player with no native chrome.
 *   onTick({ currentTime, duration, playing })   every 250ms while active
 *   onEnded()                                     clip finished (card loops it)
 *   onPlaying()                                   first frame is on screen
 * `prewarm` buffers the clip silently while it is the next card, so the swipe lands on moving video.
 */
export default function YouTubePlayer({ item, active, soundOn, paused, prewarm, onTick, onEnded, onPlaying, onSoundBlocked, onBroken, playerRef }) {
  const elRef = useRef(null);
  const pRef = useRef(null);
  const readyRef = useRef(false);
  // Player callbacks outlive renders, so they read live values from a ref.
  const live = useRef({});
  live.current = { active, soundOn, paused, prewarm, onEnded, onPlaying, onSoundBlocked, onBroken };
  const warmed = useRef(false);
  const blockTimer = useRef(0);

  const apply = () => {
    const p = pRef.current;
    if (!p || !readyRef.current) return;
    const s = live.current;
    clearTimeout(blockTimer.current);
    try {
      if (s.active && !s.paused) {
        if (s.soundOn) { p.unMute(); p.setVolume(100); } else p.mute();
        p.playVideo();
        if (s.soundOn) {
          // Some browsers (iOS Safari above all) refuse to start a new video with sound unless
          // a tap started it. If it has not begun, play it muted and ask for a tap on the card.
          blockTimer.current = setTimeout(() => {
            const now = live.current;
            if (!now.active || now.paused || !now.soundOn) return;
            let state = -1;
            try { state = p.getPlayerState(); } catch {}
            if (state !== 1 && state !== 3) {
              try { p.mute(); p.playVideo(); } catch {}
              now.onSoundBlocked?.(true);
            }
          }, 4000);
        }
      } else if (!s.active && s.prewarm && !warmed.current) {
        p.mute();
        p.playVideo(); // paused again on the first PLAYING event below
      } else {
        p.pauseVideo();
      }
    } catch {}
  };

  useEffect(() => {
    let dead = false;
    loadYT().then((YT) => {
      if (dead || !elRef.current) return;
      const p = new YT.Player(elRef.current, {
        width: "100%", height: "100%", videoId: item.externalId,
        playerVars: { autoplay: 0, controls: 0, rel: 0, playsinline: 1, modestbranding: 1, fs: 0, iv_load_policy: 3, disablekb: 1, origin: window.location.origin, mute: 1 },
        events: {
          onReady: () => { readyRef.current = true; apply(); },
          // 100 = removed or private, 101/150 = owner disabled embedding: definitive for everyone.
          // 2/5 = this player could not play it, which may be local.
          onError: (e) => live.current.onBroken?.([100, 101, 150].includes(e.data)),
          onStateChange: (e) => {
            const s = live.current;
            if (e.data === YT.PlayerState.ENDED) s.onEnded?.();
            if (e.data === YT.PlayerState.PLAYING) {
              if (s.active) s.onPlaying?.();
              else {
                // Prewarm finished buffering: rewind and hold, muted, until the card is active.
                warmed.current = true;
                try { p.pauseVideo(); p.seekTo(0, true); } catch {}
              }
            }
          },
        },
      });
      pRef.current = p;
      if (playerRef) playerRef.current = p;
    });
    return () => {
      dead = true;
      try { pRef.current?.destroy(); } catch {}
      pRef.current = null;
      readyRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  useEffect(apply, [active, paused, prewarm, soundOn]);

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      const p = pRef.current;
      if (!p || !readyRef.current || typeof p.getCurrentTime !== "function") return;
      try { onTick?.({ currentTime: p.getCurrentTime(), duration: p.getDuration(), playing: p.getPlayerState() === 1 }); } catch {}
    }, 250);
    return () => clearInterval(t);
  }, [active, onTick]);

  return <div className="frame"><div ref={elRef} style={{ width: "100%", height: "100%" }} /></div>;
}
