import React, { useState } from "react";
import { laughHeadline, laughSubline, shareLaughCard } from "../lib/laughRecap.js";
import Poster from "./Poster.jsx";

const SRC = { youtube: "Shorts", tiktok: "TikTok", instagram: "Reels" };

/**
 * Dashboard recap: today's laugh count, a shareable card, and the clips that earned it.
 */
export default function LaughCard({ stats, name, first }) {
  const [shareState, setShareState] = useState("");
  if (!stats || !stats.total) return null;
  const headline = laughHeadline({ today: stats.today, name: first || "" });
  const sub = laughSubline(stats);
  const share = async () => {
    setShareState("busy");
    try {
      const how = await shareLaughCard({ ...stats, name: name || first || "" });
      setShareState(how === "cancelled" ? "" : how);
    } catch {
      setShareState("error");
    }
  };
  return (
    <div className="card laughcard" data-testid="laugh-card">
      <div className="laughcard-hero">
        <div className="tiny">MADE ME LAUGH</div>
        <div className="laughcard-num" aria-hidden="true">{stats.today}</div>
        <h2>{headline}</h2>
        {sub && <p className="muted" style={{ margin: "6px 0 0" }}>{sub}</p>}
        <button className="btn sm primary" onClick={share} disabled={shareState === "busy"} data-testid="laugh-share">
          {shareState === "busy" ? "Making the card…" : shareState === "shared" ? "Shared" : shareState === "downloaded" ? "Saved the card" : "Share a recap card"}
        </button>
        {shareState === "error" && <p className="tiny">Couldn't make the image this time.</p>}
        <p className="tiny" style={{ margin: "10px 0 0" }}>Caught on this device. The face never left it — only the clip is remembered.</p>
      </div>
      {stats.clips?.length > 0 && (
        <>
          <div className="cardhead" style={{ margin: "16px 0 10px" }}><h2>Clips that made you laugh</h2><span className="tiny">opens on its platform</span></div>
          <div className="grid small">
            {stats.clips.map((v) => (
              <a key={v.id} className="tile" href={v.url} target="_blank" rel="noreferrer">
                <div className="tilebg" />
                <Poster item={v} className="tileimg" />
                <div className="tileshade" />
                <span className={`srcpill ${v.source}`}>{SRC[v.source] || v.source}</span>
                <span className="tiletitle">{v.title || v.creator}</span>
              </a>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
