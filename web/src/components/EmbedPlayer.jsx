import React from "react";

/**
 * Instagram's official embed. It exposes no playback API, so the card tracks dwell time and the
 * viewer taps the video to start it. The embed is a white post card: a 54px header, then the video
 * in a 4:5 box, then a footer. The `ig` frame styles oversize and offset the iframe so that the
 * video inside that box fills the 9:16 frame and the card chrome is cropped away.
 */
export default function EmbedPlayer({ item, onLoaded }) {
  return (
    <div className="frame ig">
      <iframe title={item.title || item.source} src={`https://www.instagram.com/reel/${item.externalId}/embed/`}
        allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen loading="eager" onLoad={onLoaded}
        sandbox="allow-scripts allow-same-origin allow-popups allow-presentation" />
    </div>
  );
}
