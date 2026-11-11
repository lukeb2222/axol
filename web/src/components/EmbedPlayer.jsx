import React, { useEffect, useRef, useState } from "react";

/**
 * Instagram's official embed. It exposes no playback API, so the card tracks dwell time and the
 * viewer taps the video to start it. The embed is a white post card: a 54px header, then the video
 * in a 4:5 box, then a footer. The `ig` frame styles oversize and offset the iframe so that the
 * video inside that box fills the 9:16 frame and the card chrome is cropped away.
 *
 * The embed reports its own lifecycle to the parent page: every embed posts LOADING, and only one
 * with a real post goes on to post MOUNTED / MEASURE. A removed or private reel stops at LOADING
 * and shows a white "link may be broken" page, so the iframe is kept invisible until MOUNTED, and
 * a reel that never mounts is reported as unavailable.
 */
const ORIGIN = "https://www.instagram.com";

export default function EmbedPlayer({ item, onLoaded, onBroken }) {
  const ref = useRef(null);
  const [mounted, setMounted] = useState(false);
  const cb = useRef({});
  cb.current = { onLoaded, onBroken };

  useEffect(() => {
    let sawLoading = false, done = false;
    const onMsg = (e) => {
      if (e.origin !== ORIGIN || e.source !== ref.current?.contentWindow) return;
      let m = e.data;
      if (typeof m === "string") { try { m = JSON.parse(m); } catch { return; } }
      if (m?.type === "LOADING") sawLoading = true;
      if ((m?.type === "MOUNTED" || m?.type === "MEASURE") && !done) { done = true; setMounted(true); cb.current.onLoaded?.(); }
    };
    window.addEventListener("message", onMsg);
    // Loaded but never mounted = Instagram says the post is gone (definitive). Silence = network.
    const t = setTimeout(() => { if (!done) cb.current.onBroken?.(sawLoading); }, 7000);
    return () => { window.removeEventListener("message", onMsg); clearTimeout(t); };
  }, [item.id]);

  return (
    <div className={`frame ig ${mounted ? "" : "wait"}`}>
      <iframe ref={ref} title={item.title || item.source} src={`${ORIGIN}/reel/${item.externalId}/embed/`}
        allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen loading="eager"
        sandbox="allow-scripts allow-same-origin allow-popups allow-presentation" />
    </div>
  );
}
