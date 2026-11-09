import React from "react";

/** TikTok / Instagram official embed players. Playback progress isn't exposed, so the card tracks dwell time. */
export default function EmbedPlayer({ item }) {
  const src = item.embedKind === "tiktok"
    ? `https://www.tiktok.com/embed/v2/${item.externalId}?autoplay=1&lang=en-US`
    : `https://www.instagram.com/reel/${item.externalId}/embed/`;
  return (
    <div className="frame">
      <iframe title={item.title || item.source} src={src} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen loading="eager" sandbox="allow-scripts allow-same-origin allow-popups allow-presentation" />
    </div>
  );
}
