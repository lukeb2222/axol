import React, { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import Poster from "../components/Poster.jsx";
import { Flame } from "../components/Icons.jsx";

const NAMES = { youtube: "YouTube Shorts", tiktok: "TikTok", instagram: "Instagram Reels" };
const pretty = (t) => t.replace(/-/g, " ");
const signed = (n, unit = "") => `${n > 0 ? "+" : n < 0 ? "−" : "±"}${Math.abs(n)}${unit}`;

/** One headline number. The delta is described in words and ink, never by color alone. */
function Tile({ label, value, sub, icon }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{icon}{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

/** Minutes watched per day. One series, so no legend: the card title names it. */
function WeekChart({ daily }) {
  const [hover, setHover] = useState(null);
  const max = Math.max(1, ...daily.map((d) => d.minutes));
  const peak = daily.reduce((best, d, i) => (d.minutes > daily[best].minutes ? i : best), 0);
  // The readout under the chart always shows one day: the hovered or focused one, else today.
  const shown = hover ?? daily.length - 1;
  const r = daily[shown];
  return (
    <div className="viz">
      <div className="cols" onMouseLeave={() => setHover(null)}>
        {daily.map((d, i) => {
          const h = (d.minutes / max) * 100;
          const isToday = i === daily.length - 1;
          return (
            <button key={d.date} className={`col ${hover === i ? "on" : ""}`} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} onClick={() => setHover(i)}
              aria-label={`${d.label} ${d.date}: ${d.minutes} minutes, ${d.clips} clips`}>
              <span className="colplot">
                {/* Label only the peak and today; the tooltip and table carry the rest. */}
                {(i === peak || isToday) && d.minutes > 0 && <span className="collabel" style={{ bottom: `calc(${h}% + 4px)` }}>{d.minutes}</span>}
                <span className="bar" style={{ height: `${h}%` }} />
              </span>
              <span className={`coltick ${isToday ? "today" : ""}`}>{isToday ? "Today" : d.label}</span>
            </button>
          );
        })}
      </div>
      <div className="readout" aria-live="polite">
        <strong>{r.minutes} min</strong>
        <span>{r.clips} clip{r.clips === 1 ? "" : "s"}{r.completion != null ? ` · ${r.completion}% watched through` : ""}</span>
        <span className="readout-day">{shown === daily.length - 1 ? "Today" : `${r.label} ${r.date.slice(5)}`}</span>
      </div>
      <details className="tableview">
        <summary>View as table</summary>
        <table>
          <thead><tr><th>Day</th><th>Minutes</th><th>Clips</th><th>Watched through</th></tr></thead>
          <tbody>{daily.map((d) => <tr key={d.date}><td>{d.label} {d.date.slice(5)}</td><td>{d.minutes}</td><td>{d.clips}</td><td>{d.completion != null ? `${d.completion}%` : "–"}</td></tr>)}</tbody>
        </table>
      </details>
    </div>
  );
}

/** Share of watch time per platform: a meter list (name, bar, figure), bars aligned. */
function Platforms({ rows }) {
  return (
    <div className="meters">
      {rows.map((p) => (
        <div className="meter" key={p.source} title={`${NAMES[p.source] || p.source}: ${p.minutes} min across ${p.clips} clips, ${p.completion}% watched through`}>
          <div className="meter-name">{NAMES[p.source] || p.source}</div>
          <div className="meter-track"><div className="meter-fill" style={{ width: `${Math.max(2, p.share)}%` }} /></div>
          <div className="meter-fig"><strong>{p.share}%</strong><span>{p.minutes} min · {p.completion}% through</span></div>
        </div>
      ))}
    </div>
  );
}

/** Engagement by topic around a neutral midpoint: right = watched through, left = skipped. */
function Attention({ landing, skipping }) {
  const rows = [...landing, ...skipping.slice().reverse()];
  const max = Math.max(0.5, ...rows.map((r) => Math.abs(r.score)));
  return (
    <div className="diverge">
      <div className="diverge-axis"><span>◀ skipped</span><span>watched through ▶</span></div>
      {rows.map((r) => {
        const w = (Math.abs(r.score) / max) * 50;
        const pos = r.score >= 0;
        return (
          <div className="drow" key={r.tag} title={`${pretty(r.tag)}: engagement ${r.score > 0 ? "+" : ""}${r.score} across ${r.clips} clips`}>
            <div className="dname">{pretty(r.tag)}</div>
            <div className="dtrack">
              <span className="dmid" />
              <span className={`dbar ${pos ? "pos" : "neg"}`} style={pos ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }} />
            </div>
            <div className="dval">{r.score > 0 ? "+" : "−"}{Math.abs(r.score).toFixed(2)}</div>
          </div>
        );
      })}
    </div>
  );
}

export default function Dashboard({ user, onGoReels }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => { api.dashboard().then(setD).catch((e) => setErr(e.message)); }, []);

  if (err) return <div className="page"><div className="shell"><div className="error">{err}</div></div></div>;
  if (!d) return <div className="page"><div className="shell"><div className="skeleton tall"><div className="shimmer" /></div></div></div>;

  const first = (user.name || "").split(" ")[0];
  const fresh = d.totals.clips === 0;
  const hours = d.totals.minutes >= 90 ? `${(d.totals.minutes / 60).toFixed(1)} h` : `${d.totals.minutes} min`;

  return (
    <div className="page">
      <div className="shell wide fade-in">
        <div>
          <h1>{first ? `${first}'s dashboard` : "Your dashboard"}</h1>
          <p className="muted" style={{ margin: "6px 0 0" }}>What you watch, what holds you, and how your feed is changing because of it.</p>
        </div>

        {fresh ? (
          <div className="card" style={{ display: "grid", gap: 12, justifyItems: "start" }}>
            <h2>Nothing to chart yet</h2>
            <p className="muted" style={{ margin: 0 }}>Watch a few clips and this page fills in: your watch time, the topics that hold your attention, and every time the feed re-tunes itself.</p>
            <button className="btn primary sm" onClick={onGoReels}>Start watching</button>
          </div>
        ) : (
          <>
            <div className="kpis">
              <Tile label="Clips today" value={d.today.clips} sub={`${signed(d.today.clipsDelta)} vs yesterday`} />
              <Tile label="Minutes today" value={d.today.minutes} sub={`${signed(d.today.minutesDelta)} vs yesterday`} />
              <Tile label="Watched through" value={d.totals.completion != null ? `${d.totals.completion}%` : "–"} sub={`${d.totals.skipRate ?? 0}% skipped early`} />
              <Tile label="Day streak" value={d.streak} icon={d.streak > 1 ? <Flame className="flame" /> : null} sub={d.streak === 1 ? "day in a row" : "days in a row"} />
            </div>

            <div className="card">
              <div className="cardhead"><h2>Watch time, last 7 days</h2><span className="tiny">minutes per day</span></div>
              <WeekChart daily={d.daily} />
            </div>

            {(d.landing.length > 0 || d.skipping.length > 0) && (
              <div className="card">
                <div className="cardhead"><h2>What holds your attention</h2><span className="tiny">recent clips, by topic</span></div>
                <Attention landing={d.landing} skipping={d.skipping} />
                <p className="tiny" style={{ margin: "10px 0 0" }}>This is the signal your feed learns from. Topics on the right get more room; topics on the left fade out.</p>
              </div>
            )}

            {d.platforms.length > 0 && (
              <div className="card">
                <div className="cardhead"><h2>Where your time goes</h2><span className="tiny">share of watch time</span></div>
                <Platforms rows={d.platforms} />
              </div>
            )}

            <div className="card taste">
              <div className="cardhead"><h2>Your taste engine</h2><span className="tiny">{d.taste.tunes} re-tune{d.taste.tunes === 1 ? "" : "s"} so far</span></div>
              <p style={{ margin: 0, lineHeight: 1.5 }}>{d.taste.summary || "Still forming a picture of you."}</p>
              <div className="minis">
                <span><strong>{d.taste.interests}</strong> interests tracked</span>
                <span><strong>{d.taste.learned}</strong> picked up from watching</span>
                <span><strong>{d.totals.likes}</strong> likes · <strong>{d.totals.replays}</strong> replays</span>
                <span><strong>{hours}</strong> watched in total</span>
              </div>
              {d.insights.length > 0 && (
                <div className="log" style={{ marginTop: 6 }}>
                  {d.insights.slice(0, 3).map((l, i) => <div className="item" key={i}><div>{l.summary}</div><div className="tiny">{new Date(l.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</div></div>)}
                </div>
              )}
            </div>

            {d.liked.length > 0 && (
              <div>
                <div className="cardhead"><h2>Clips you liked</h2><span className="tiny">opens on its platform</span></div>
                <div className="grid small">
                  {d.liked.map((v) => (
                    <a key={v.id} className="tile" href={v.url} target="_blank" rel="noreferrer">
                      <div className="tilebg" />
                      <Poster item={v} className="tileimg" />
                      <div className="tileshade" />
                      <span className={`srcpill ${v.source}`}>{v.source === "youtube" ? "Shorts" : v.source === "tiktok" ? "TikTok" : "Reels"}</span>
                      <span className="tiletitle">{v.title || v.creator}</span>
                    </a>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
