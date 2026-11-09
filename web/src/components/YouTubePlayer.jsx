import React, { useEffect, useRef } from "react";
import { loadYT } from "../lib/youtube.js";

/**
 * Official YouTube IFrame player with no native chrome. Reports playback to the card:
 *   onTick({ currentTime, duration, playing })   every 250ms
 *   onEnded()                                     clip finished (card decides to loop)
 */
export default function YouTubePlayer({ item, active, soundOn, paused, onTick, onEnded, playerRef }) {
  const elRef = useRef(null);
  const pRef = useRef(null);
  const readyRef = useRef(false);

  useEffect(() => {
    let dead = false;
    loadYT().then((YT) => {
      if (dead || !elRef.current) return;
      const playerVars = {
        autoplay: 0, controls: 0, rel: 0, playsinline: 1, modestbranding: 1, fs: 0, iv_load_policy: 3, disablekb: 1,
        origin: window.location.origin, mute: 1,
      };
      const p = new YT.Player(elRef.current, {
        width: "100%", height: "100%", videoId: item.externalId, playerVars,
        events: {
          onReady: () => {
            readyRef.current = true;
            if (soundOn) p.unMute(); else p.mute();
            if (active && !paused) p.playVideo();
          },
          onStateChange: (e) => {
            if (e.data === YT.PlayerState.ENDED) onEnded?.();
          },
          onError: () => { /* unplayable clip: card will be skipped by the user; nothing to do */ },
        },
      });
      pRef.current = p;
      if (playerRef) playerRef.current = p;
    });
    return () => {
      dead = true;
      try { pRef.current?.destroy(); } catch {}
      pRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  // Play / pause with activation.
  useEffect(() => {
    const p = pRef.current;
    if (!p || !readyRef.current) return;
    try { active && !paused ? p.playVideo() : p.pauseVideo(); } catch {}
  }, [active, paused]);

  useEffect(() => {
    const p = pRef.current;
    if (!p || !readyRef.current) return;
    try { soundOn ? p.unMute() : p.mute(); } catch {}
  }, [soundOn]);

  // Progress polling.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      const p = pRef.current;
      if (!p || !readyRef.current || typeof p.getCurrentTime !== "function") return;
      try {
        const state = p.getPlayerState();
        onTick?.({ currentTime: p.getCurrentTime(), duration: p.getDuration(), playing: state === 1 });
      } catch {}
    }, 250);
    return () => clearInterval(t);
  }, [active, onTick]);

  return <div className="frame"><div ref={elRef} style={{ width: "100%", height: "100%" }} /></div>;
}
