import React, { useState } from "react";
import { posterCandidates } from "../lib/posters.js";

/** Tries each candidate image in order; renders nothing if none load. */
export default function Poster({ item, className = "posterimg" }) {
  const list = posterCandidates(item);
  const [i, setI] = useState(0);
  if (i >= list.length) return null;
  return <img className={className} src={list[i]} alt="" decoding="async" draggable={false}
    onError={() => setI((n) => n + 1)}
    // YouTube answers a missing oar2 with a 120x90 grey placeholder instead of an error.
    onLoad={(e) => { if (item.source === "youtube" && e.currentTarget.naturalWidth <= 120) setI((n) => n + 1); }} />;
}
