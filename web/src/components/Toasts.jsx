import React from "react";
import { Sparkle } from "./Icons.jsx";

/** Shows what the feed just learned. Items: { id, big, text, deltas } */
export default function Toasts({ items }) {
  return (
    <div className="toasts">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.big ? "big" : ""}`}>
          <Sparkle className="spark" />
          {t.text ? <span>{t.text}</span> : (
            <span>
              Learned:&nbsp;
              {t.deltas.map((d, i) => (
                <span key={d.tag}>
                  {i > 0 && ", "}
                  <span className={d.delta >= 0 ? "up" : "down"}>{d.delta >= 0 ? "▲" : "▼"} {d.tag.replace(/-/g, " ")}</span>
                </span>
              ))}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
