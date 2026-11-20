import React, { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.js";

const NAMES = { youtube: "YouTube Shorts", tiktok: "TikTok", instagram: "Instagram Reels" };
const pretty = (t) => String(t || "").replace(/-/g, " ");
const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "–");
const dayOf = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "–");
const mins = (ms) => { const m = Math.round(ms / 60000); return m >= 90 ? `${(m / 60).toFixed(1)} h` : `${m} min`; };
const secs = (ms) => (ms ? `${(ms / 1000).toFixed(1)}s` : "–");
function ago(ms) {
  if (!ms) return "never";
  const s = (Date.now() - ms) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** One activity row in words. */
function describe(kind, d = {}) {
  switch (kind) {
    case "signup": return d.invited ? "Signed up through an invite link" : "Signed up";
    case "login": return "Signed in";
    case "onboarding": return `Told axol what they like: “${d.text || ""}”${d.chips?.length ? ` · picked ${d.chips.map(pretty).join(", ")}` : ""}`;
    case "search": return `Searched “${d.q}” · ${d.results} result${d.results === 1 ? "" : "s"}`;
    case "search_fresh": return `Asked for fresh clips about “${d.q}”`;
    case "import": return `Pasted ${d.links?.length || 0} link${d.links?.length === 1 ? "" : "s"}${d.links?.length ? `: ${d.links.join(" ")}` : ""}`;
    case "steer": return `${d.direction === "less" ? "Less" : "More"} ${pretty(d.tag)}`;
    case "interest": return `${d.action === "mute" ? "Muted" : d.action === "boost" ? "Boosted" : "Removed"} ${pretty(d.tag)}`;
    case "retune": return "Asked for a re-tune";
    case "feedback": return `Feedback: “${d.text || ""}”`;
    case "ad_submit": return `Submitted an ad: ${d.url}`;
    case "ad_approved": return "Their ad was approved";
    case "ad_rejected": return "Their ad was not approved";
    case "ad_ended": return "Their ad was ended";
    case "invite_used": return "Someone signed up with their invite link";
    case "owner_access": return "Turned on owner access";
    case "export": return `Downloaded the ${d.name} export`;
    case "member_deleted": return "Deleted a member";
    default: return `${kind} ${JSON.stringify(d)}`;
  }
}

function Tile({ label, value, sub }) {
  return <div className="kpi"><div className="kpi-label">{label}</div><div className="kpi-value">{value}</div>{sub && <div className="kpi-sub">{sub}</div>}</div>;
}

/** People active per day. One series, so the card title names it; the readout carries the rest. */
function DailyChart({ daily }) {
  const [hover, setHover] = useState(null);
  const max = Math.max(1, ...daily.map((d) => d.activeUsers));
  const peak = daily.reduce((best, d, i) => (d.activeUsers > daily[best].activeUsers ? i : best), 0);
  const shown = hover ?? daily.length - 1, r = daily[shown];
  return (
    <div className="viz">
      <div className="cols d14" onMouseLeave={() => setHover(null)}>
        {daily.map((d, i) => {
          const h = (d.activeUsers / max) * 100, isToday = i === daily.length - 1;
          return (
            <button key={d.date} className={`col ${hover === i ? "on" : ""}`} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} onClick={() => setHover(i)}
              aria-label={`${d.date}: ${d.activeUsers} active, ${d.newUsers} new, ${d.clips} clips, ${d.minutes} minutes`}>
              <span className="colplot">
                {(i === peak || isToday) && d.activeUsers > 0 && <span className="collabel" style={{ bottom: `calc(${h}% + 4px)` }}>{d.activeUsers}</span>}
                <span className="bar" style={{ height: `${h}%` }} />
              </span>
              <span className={`coltick ${isToday ? "today" : ""}`}>{isToday ? "Today" : i % 2 ? "" : d.date.slice(8)}</span>
            </button>
          );
        })}
      </div>
      <div className="readout" aria-live="polite">
        <strong>{r.activeUsers} active</strong>
        <span>{r.newUsers} new · {r.clips} clips · {r.minutes} min watched</span>
        <span className="readout-day">{shown === daily.length - 1 ? "Today" : `${r.label} ${r.date.slice(5)}`}</span>
      </div>
      <details className="tableview">
        <summary>View as table</summary>
        <table>
          <thead><tr><th>Day</th><th>Active</th><th>New</th><th>Clips</th><th>Minutes</th></tr></thead>
          <tbody>{daily.map((d) => <tr key={d.date}><td>{d.label} {d.date.slice(5)}</td><td>{d.activeUsers}</td><td>{d.newUsers}</td><td>{d.clips}</td><td>{d.minutes}</td></tr>)}</tbody>
        </table>
      </details>
    </div>
  );
}

/** Plain-language pointers to what might need changing, worked out from the numbers. */
function signals(d) {
  const out = [];
  const [signed, setup, watched, , back] = d.funnel.map((f) => f.n);
  if (signed >= 5 && setup / signed < 0.8) out.push(`${signed - setup} of ${signed} sign-ups never finished setup. The setup screen may be asking too much.`);
  if (watched >= 5 && back / watched < 0.3) out.push(`Only ${back} of ${watched} people who watched came back on another day.`);
  for (const s of d.searches.empty.slice(0, 4)) out.push(`“${s.q}” was searched ${s.times} time${s.times === 1 ? "" : "s"} and found nothing. axol has no clips for it.`);
  for (const s of d.sources) {
    if (s.medianStartMs > 3000) out.push(`${NAMES[s.source] || s.source} clips take ${secs(s.medianStartMs)} to start (middle value, last 7 days).`);
    if (s.broken >= 5) out.push(`${s.broken} ${NAMES[s.source] || s.source} clips failed to play in the last 7 days.`);
    if (s.clips >= 20 && s.skipRate >= 50) out.push(`${s.skipRate}% of ${NAMES[s.source] || s.source} clips are skipped early.`);
  }
  for (const t of d.topics.skipped.filter((x) => x.skipRate >= 60 && x.shown >= 10).slice(0, 3)) out.push(`“${pretty(t.tag)}” is skipped ${t.skipRate}% of the time across ${t.shown} showings.`);
  if (d.referrals.adsPending) out.push(`${d.referrals.adsPending} member ad${d.referrals.adsPending === 1 ? " is" : "s are"} waiting for your review (Ads tab).`);
  return out;
}

function Overview({ openUser }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => { api.admin.overview().then(setD).catch((e) => setErr(e.message)); }, []);
  if (err) return <div className="error">{err}</div>;
  if (!d) return <div className="skeleton tall"><div className="shimmer" /></div>;
  const t = d.totals, list = signals(d), top = d.funnel[0].n || 1;
  const Count = ({ rows, empty }) => (rows.length ? <div className="chips">{rows.map((r) => <span className="chip static" key={r.tag}>{pretty(r.tag)} <b>{r.count}</b></span>)}</div> : <p className="tiny">{empty}</p>);
  return (
    <>
      <div className="kpis">
        <Tile label="Members" value={t.users} sub={`${t.newThisWeek} new this week`} />
        <Tile label="Active today" value={t.activeToday} sub={`${t.activeWeek} this week · ${t.activeMonth} this month`} />
        <Tile label="Clips watched" value={t.clips} sub={`${t.hours} hours in total`} />
        <Tile label="Watched through" value={t.completion != null ? `${t.completion}%` : "–"} sub={`${t.skipRate ?? 0}% skipped early · ${t.likes} likes`} />
      </div>

      <div className="card" data-testid="signals">
        <div className="cardhead"><h2>Worth a look</h2><span className="tiny">worked out from the numbers below</span></div>
        {list.length ? <ul className="signals">{list.map((s, i) => <li key={i}>{s}</li>)}</ul> : <p className="muted" style={{ margin: 0 }}>Nothing stands out yet. This fills in as more people use axol.</p>}
      </div>

      <div className="card"><div className="cardhead"><h2>People active each day</h2><span className="tiny">last 14 days</span></div><DailyChart daily={d.daily} /></div>

      <div className="card">
        <div className="cardhead"><h2>How far people get</h2><span className="tiny">all accounts</span></div>
        <div className="meters">
          {d.funnel.map((f) => (
            <div className="meter" key={f.step}>
              <div className="meter-name">{f.step}</div>
              <div className="meter-track"><div className="meter-fill" style={{ width: `${Math.max(f.n ? 2 : 0, (f.n / top) * 100)}%` }} /></div>
              <div className="meter-fig"><strong>{f.n}</strong><span>{Math.round((f.n / top) * 100)}% of sign-ups</span></div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="cardhead"><h2>By platform</h2><span className="tiny">last 30 days</span></div>
        <div className="tablewrap"><table className="atable">
          <thead><tr><th>Platform</th><th>Clips</th><th>Watched through</th><th>Skipped early</th><th>Liked</th><th>Time to start</th><th>Failed to play</th></tr></thead>
          <tbody>{d.sources.map((s) => <tr key={s.source}><td>{NAMES[s.source] || s.source}</td><td>{s.clips}</td><td>{s.completion ?? "–"}%</td><td>{s.skipRate ?? "–"}%</td><td>{s.likeRate ?? "–"}%</td><td>{secs(s.medianStartMs)}</td><td>{s.broken}</td></tr>)}</tbody>
        </table></div>
        {!d.sources.length && <p className="tiny">No finished clips yet.</p>}
      </div>

      <div className="twocol">
        <div className="card">
          <div className="cardhead"><h2>Topics that hold people</h2></div>
          <table className="atable"><thead><tr><th>Topic</th><th>Shown</th><th>Watched through</th></tr></thead>
            <tbody>{d.topics.best.map((r) => <tr key={r.tag}><td>{pretty(r.tag)}</td><td>{r.shown}</td><td>{r.completion}%</td></tr>)}</tbody></table>
        </div>
        <div className="card">
          <div className="cardhead"><h2>Topics people skip</h2></div>
          <table className="atable"><thead><tr><th>Topic</th><th>Shown</th><th>Skipped early</th><th>“Not me”</th></tr></thead>
            <tbody>{d.topics.skipped.map((r) => <tr key={r.tag}><td>{pretty(r.tag)}</td><td>{r.shown}</td><td>{r.skipRate}%</td><td>{r.notMe}</td></tr>)}</tbody></table>
        </div>
      </div>

      <div className="twocol">
        <div className="card">
          <div className="cardhead"><h2>What people search for</h2><span className="tiny">last 30 days</span></div>
          {d.searches.top.length ? <table className="atable"><thead><tr><th>Search</th><th>Times</th><th>People</th><th>Results</th></tr></thead>
            <tbody>{d.searches.top.map((r) => <tr key={r.q}><td>{r.q}</td><td>{r.times}</td><td>{r.people}</td><td>{r.results}</td></tr>)}</tbody></table> : <p className="tiny">No searches recorded yet.</p>}
        </div>
        <div className="card">
          <div className="cardhead"><h2>Searches that found nothing</h2></div>
          {d.searches.empty.length ? <table className="atable"><thead><tr><th>Search</th><th>Times</th><th>People</th></tr></thead>
            <tbody>{d.searches.empty.map((r) => <tr key={r.q}><td>{r.q}</td><td>{r.times}</td><td>{r.people}</td></tr>)}</tbody></table> : <p className="tiny">None. Every recorded search found clips.</p>}
        </div>
      </div>

      <div className="card"><div className="cardhead"><h2>What people ask for at sign-up</h2><span className="tiny">number of people</span></div><Count rows={d.asked} empty="No sign-ups yet." /></div>
      <div className="twocol">
        <div className="card"><div className="cardhead"><h2>Topics people muted</h2></div><Count rows={d.muted} empty="Nobody has muted a topic." /></div>
        <div className="card"><div className="cardhead"><h2>Topics people asked for less of</h2></div><Count rows={d.less} empty="Nobody has tapped Less yet." /></div>
      </div>

      {d.notMeClips.length > 0 && (
        <div className="card">
          <div className="cardhead"><h2>Clips marked “Not me” most</h2></div>
          <table className="atable"><tbody>{d.notMeClips.map((c) => <tr key={c.url}><td><a href={c.url} target="_blank" rel="noopener">{c.title || c.url}</a></td><td>{NAMES[c.source] || c.source}</td><td>{c.count}</td></tr>)}</tbody></table>
        </div>
      )}

      <div className="card">
        <div className="cardhead"><h2>Latest feedback</h2><span className="tiny">{t.feedback} in total</span></div>
        {d.feedback.length ? <div className="timeline">{d.feedback.map((f) => <div className="titem" key={f.id}><div>“{f.text}”</div><div className="tiny"><button className="linkish" onClick={() => openUser(f.userId)}>{f.name || f.email}</button> · {when(f.at)}</div></div>)}</div>
          : <p className="tiny">No feedback yet. Members can send it from the You tab.</p>}
      </div>

      <div className="card">
        <div className="cardhead"><h2>Invites</h2></div>
        <div className="minis"><span><strong>{d.referrals.linksUsed}</strong> links used</span><span><strong>{d.referrals.joined}</strong> finished setup</span><span><strong>{d.referrals.members}</strong> members have invited someone</span><span><strong>{d.referrals.adsPending}</strong> ads to review</span><span><strong>{d.referrals.adsRunning}</strong> ads running</span></div>
      </div>
      <p className="tiny">Catalog: {d.system.catalog} clips{d.system.aiSpendUsd != null ? ` · AI spend this month: $${d.system.aiSpendUsd}` : ""} · updated {when(d.generatedAt)}</p>
    </>
  );
}

function Users({ openUser }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("newest");
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const load = useCallback((offset = 0) => {
    api.admin.users({ q, sort, offset }).then((r) => setD((prev) => (offset ? { total: r.total, users: [...prev.users, ...r.users] } : r))).catch((e) => setErr(e.message));
  }, [q, sort]);
  useEffect(() => { const t = setTimeout(() => load(0), 250); return () => clearTimeout(t); }, [load]);
  return (
    <>
      <div className="row wrap">
        <input style={{ flex: 1, minWidth: 180 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find by name or email" aria-label="Find a member" />
        <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort"><option value="newest">Newest first</option><option value="active">Recently active</option><option value="watched">Most watched</option></select>
      </div>
      {err && <div className="error">{err}</div>}
      {d && (
        <div className="card">
          <div className="cardhead"><h2>{d.total} member{d.total === 1 ? "" : "s"}</h2><span className="tiny">tap one to see everything about them</span></div>
          <div className="tablewrap"><table className="atable" data-testid="users">
            <thead><tr><th>Member</th><th>Joined</th><th>Last active</th><th>Clips</th><th>Watched</th><th>Searches</th><th>Invited</th></tr></thead>
            <tbody>{d.users.map((u) => (
              <tr key={u.id} className="clickable" onClick={() => openUser(u.id)}>
                <td><strong>{u.name}</strong>{u.is_admin ? <span className="badge" style={{ marginLeft: 6 }}>owner</span> : null}{!u.onboarded && <span className="badge" style={{ marginLeft: 6 }}>setup not finished</span>}<div className="tiny">{u.email}</div></td>
                <td>{dayOf(u.created_at)}</td><td>{ago(u.last_active)}</td><td>{u.clips}</td><td>{mins(u.watched_ms)}</td><td>{u.searches}</td><td>{u.invited}</td>
              </tr>
            ))}</tbody>
          </table></div>
          {d.users.length < d.total && <button className="btn ghost sm" style={{ marginTop: 12 }} onClick={() => load(d.users.length)}>Show more</button>}
        </div>
      )}
    </>
  );
}

function UserDetail({ id, back, openUser }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => { setD(null); api.admin.user(id).then(setD).catch((e) => setErr(e.message)); }, [id]);
  if (err) return <div className="error">{err}</div>;
  if (!d) return <div className="skeleton tall"><div className="shimmer" /></div>;
  const u = d.user;
  const remove = async () => {
    if (!window.confirm(`Delete ${u.email} and everything recorded about them? This cannot be undone.`)) return;
    try { await api.admin.deleteUser(u.id); back(); } catch (e) { setErr(e.message); }
  };
  return (
    <>
      <button className="btn ghost sm" style={{ width: "fit-content" }} onClick={back}>← All members</button>
      <div className="card" data-testid="userdetail">
        <h2>{u.name}</h2>
        <div className="muted">{u.email}</div>
        <div className="minis" style={{ marginTop: 10 }}>
          <span>Joined <strong>{dayOf(u.created_at)}</strong></span><span>Last active <strong>{ago(u.last_active)}</strong></span><span><strong>{u.clips}</strong> clips</span>
          <span><strong>{mins(u.watched_ms)}</strong> watched</span><span><strong>{u.likes}</strong> likes</span><span><strong>{u.searches}</strong> searches</span>
        </div>
        {u.invitedBy && <p className="tiny" style={{ marginBottom: 0 }}>Invited by <button className="linkish" onClick={() => openUser(u.invitedBy.id)}>{u.invitedBy.name || u.invitedBy.email}</button></p>}
        {d.invites.length > 0 && <p className="tiny" style={{ marginBottom: 0 }}>Invited: {d.invites.map((i) => i.name || i.email).join(", ")}</p>}
      </div>
      <div className="card">
        <div className="cardhead"><h2>What they typed at sign-up</h2></div>
        <p style={{ margin: 0 }}>{d.typed.onboardingText ? `“${d.typed.onboardingText}”` : <span className="tiny">Nothing typed.</span>}</p>
        {d.typed.onboardingPicks.length > 0 && <div className="chips" style={{ marginTop: 10 }}>{d.typed.onboardingPicks.map((c) => <span className="chip static" key={c}>{pretty(c)}</span>)}</div>}
        {d.typed.muted.length > 0 && <p className="tiny" style={{ marginBottom: 0 }}>Muted: {d.typed.muted.map(pretty).join(", ")}</p>}
      </div>
      {d.profileSummary && <div className="card"><div className="cardhead"><h2>What the feed thinks of them</h2></div><p style={{ margin: 0 }}>{d.profileSummary}</p></div>}
      <div className="card">
        <div className="cardhead"><h2>Interests</h2><span className="tiny">strongest first</span></div>
        <div className="tablewrap"><table className="atable"><thead><tr><th>Topic</th><th>Weight</th><th>From</th><th>Seen</th><th>Enjoyed</th></tr></thead>
          <tbody>{d.interests.map((i) => <tr key={i.tag}><td>{pretty(i.tag)}</td><td>{i.weight}</td><td>{i.origin}</td><td>{i.impressions}</td><td>{i.positive}</td></tr>)}</tbody></table></div>
      </div>
      <div className="card">
        <div className="cardhead"><h2>Everything they did</h2><span className="tiny">newest first</span></div>
        {d.activity.length ? <div className="timeline">{d.activity.map((a) => <div className="titem" key={a.id}><div>{describe(a.kind, a.data)}</div><div className="tiny">{when(a.at)}</div></div>)}</div> : <p className="tiny">Nothing recorded yet.</p>}
      </div>
      <div className="card">
        <div className="cardhead"><h2>What they watched</h2><span className="tiny">latest 60</span></div>
        <div className="tablewrap"><table className="atable"><thead><tr><th>Clip</th><th>When</th><th>Watched</th><th>Why shown</th><th></th></tr></thead>
          <tbody>{d.watched.map((w, i) => (
            <tr key={i}><td><a href={w.url} target="_blank" rel="noopener">{w.title || w.url}</a><div className="tiny">{NAMES[w.source] || w.source}{w.creator ? ` · ${w.creator.trim()}` : ""}</div></td>
              <td>{when(w.served_at)}</td><td>{secs(w.watched_ms)}{w.duration_ms > 0 ? ` of ${secs(w.duration_ms)}` : ""}</td><td>{w.reason}</td>
              <td>{[w.liked && "liked", w.shared && "shared", w.hidden && "not me", w.skipped && "skipped", w.replays > 0 && `replayed ×${w.replays}`].filter(Boolean).join(" · ")}</td></tr>
          ))}</tbody></table></div>
      </div>
      {!u.is_admin && <button className="btn ghost sm" style={{ width: "fit-content", color: "#ff8da1" }} onClick={remove}>Delete this member and their data</button>}
    </>
  );
}

function Activity({ openUser }) {
  const [kind, setKind] = useState("");
  const [d, setD] = useState(null);
  useEffect(() => { api.admin.activity({ kind }).then(setD).catch(() => {}); }, [kind]);
  const more = () => api.admin.activity({ kind, before: d.items[d.items.length - 1].id }).then((r) => setD((p) => ({ ...p, items: [...p.items, ...r.items] })));
  if (!d) return <div className="skeleton tall"><div className="shimmer" /></div>;
  return (
    <>
      <div className="chips">
        <button className={`chip ${kind === "" ? "on" : ""}`} onClick={() => setKind("")}>Everything</button>
        {d.kinds.map((k) => <button key={k.kind} className={`chip ${kind === k.kind ? "on" : ""}`} onClick={() => setKind(k.kind)}>{k.kind.replace(/_/g, " ")} <b>{k.n}</b></button>)}
      </div>
      <div className="card">
        {d.items.length ? <div className="timeline" data-testid="activity">{d.items.map((a) => (
          <div className="titem" key={a.id}><div>{describe(a.kind, a.data)}</div><div className="tiny"><button className="linkish" onClick={() => openUser(a.userId)}>{a.name || a.email || "deleted account"}</button> · {when(a.at)}</div></div>
        ))}</div> : <p className="tiny">Nothing recorded yet.</p>}
        {d.items.length > 0 && d.items.length % 100 === 0 && <button className="btn ghost sm" style={{ marginTop: 12 }} onClick={more}>Show older</button>}
      </div>
    </>
  );
}

function Feedback({ openUser }) {
  const [d, setD] = useState(null);
  useEffect(() => { api.admin.feedback().then(setD).catch(() => {}); }, []);
  if (!d) return <div className="skeleton tall"><div className="shimmer" /></div>;
  return (
    <div className="card">
      <div className="cardhead"><h2>Feedback from members</h2><span className="tiny">{d.items.length} message{d.items.length === 1 ? "" : "s"}</span></div>
      {d.items.length ? <div className="timeline">{d.items.map((f) => <div className="titem" key={f.id}><div>“{f.text}”</div><div className="tiny"><button className="linkish" onClick={() => openUser(f.userId)}>{f.name || f.email}</button> · {when(f.at)}</div></div>)}</div>
        : <p className="muted" style={{ margin: 0 }}>Nothing yet. Members can write to you from the You tab.</p>}
    </div>
  );
}

const AD_STATE = { pending: "Waiting for your review", running: "Running", finished: "Finished", rejected: "Rejected", ended: "Ended early" };
function Ads({ openUser }) {
  const [ads, setAds] = useState(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => { api.admin.ads().then((r) => setAds(r.ads)).catch((e) => setErr(e.message)); }, []);
  const decide = async (ad, action) => {
    let note = "";
    if (action === "reject") { note = window.prompt("Reason to show the member (optional)") ?? null; if (note === null) return; }
    if (action === "end" && !window.confirm("Stop showing this ad now?")) return;
    setBusy(ad.id); setErr("");
    try { const r = await api.admin.decideAd(ad.id, action, note); setAds((list) => list.map((a) => (a.id === ad.id ? r.ad : a))); } catch (e) { setErr(e.message); } finally { setBusy(""); }
  };
  if (!ads) return err ? <div className="error">{err}</div> : <div className="skeleton tall"><div className="shimmer" /></div>;
  return (
    <>
      <p className="muted" style={{ margin: 0 }}>Members earn one ad when a friend joins through their invite link. Nothing runs until you approve it. An approved ad shows as a skippable “Sponsored” clip for 7 days.</p>
      {err && <div className="error">{err}</div>}
      {!ads.length && <div className="card"><p className="muted" style={{ margin: 0 }}>No ads submitted yet.</p></div>}
      {ads.map((a) => (
        <div className="card adreview" key={a.id} data-testid="adreview">
          {a.thumbnail && <a href={a.url} target="_blank" rel="noopener"><img src={a.thumbnail} alt="" /></a>}
          <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
            <div><span className={`badge ${a.state === "running" ? "learned" : ""}`}>{AD_STATE[a.state] || a.state}</span>{a.endsAt && a.state === "running" ? <span className="tiny"> until {dayOf(a.endsAt)}</span> : null}</div>
            <a href={a.url} target="_blank" rel="noopener"><strong>{a.title || a.url}</strong></a>
            <div className="tiny">{a.creator ? `${a.creator} · ` : ""}from <button className="linkish" onClick={() => openUser(a.member.id)}>{a.member.name || a.member.email}</button> · submitted {when(a.submittedAt)}</div>
            {a.startsAt && <div className="tiny">Shown {a.shown} times to {a.viewers} people · {a.finished} watched through · {a.clicks} channel taps</div>}
            {a.note && <div className="tiny">Reason given: {a.note}</div>}
            <div className="row wrap">
              {a.state === "pending" && <><button className="btn primary sm" disabled={busy === a.id} onClick={() => decide(a, "approve")}>Approve and run</button><button className="btn ghost sm" disabled={busy === a.id} onClick={() => decide(a, "reject")}>Reject</button></>}
              {a.state === "running" && <button className="btn ghost sm" disabled={busy === a.id} onClick={() => decide(a, "end")}>End now</button>}
              <a className="btn ghost sm" href={a.url} target="_blank" rel="noopener">Watch it</a>
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

const EXPORTS = [
  ["users", "Members", "One row per person: email, name, dates, what they typed at sign-up, totals."],
  ["activity", "Everything people did", "Sign-ups, searches, pasted links, steering, feedback, in order."],
  ["watch_history", "Watch history", "Every clip shown: who, how long they watched, likes, skips."],
  ["searches", "Searches", "Every search and how many results it found."],
  ["interests", "Interests", "Each person's topics and how strong they are."],
  ["feedback", "Feedback", "What members wrote to you."],
  ["referrals", "Invites", "Who invited whom."],
];
function Export() {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const get = async (name) => { setBusy(name); setErr(""); try { await api.admin.download(name); } catch (e) { setErr(e.message); } finally { setBusy(""); } };
  return (
    <div className="card">
      <div className="cardhead"><h2>Download the data</h2><span className="tiny">CSV, opens in Excel or Google Sheets</span></div>
      <div className="exports">{EXPORTS.map(([name, label, about]) => (
        <div className="broaden-row" key={name}><span><strong style={{ color: "var(--fg)" }}>{label}</strong><br />{about}</span><button className="btn sm ghost" disabled={busy === name} onClick={() => get(name)}>{busy === name && <span className="spin light" />}Download</button></div>
      ))}</div>
      {err && <div className="error">{err}</div>}
      <p className="tiny" style={{ marginBottom: 0 }}>Passwords are never included. These files contain members' email addresses and activity, so keep them private.</p>
    </div>
  );
}

function Claim({ onOwner }) {
  const [key, setKey] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr("");
    try { await api.admin.claim(key.trim()); history.replaceState(null, "", location.pathname); onOwner(); } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  };
  return (
    <form className="card" onSubmit={submit} style={{ display: "grid", gap: 12 }} data-testid="claim">
      <h2>Owner access</h2>
      <p className="muted" style={{ margin: 0 }}>Enter the owner key once. This account then gets an Owner tab with every member's data.</p>
      <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Owner key" autoComplete="off" required />
      {err && <div className="error">{err}</div>}
      <button className="btn primary" disabled={busy || !key.trim()}>{busy && <span className="spin" />}Unlock</button>
    </form>
  );
}

const SECTIONS = [["overview", "Overview"], ["users", "Members"], ["activity", "Activity"], ["feedback", "Feedback"], ["ads", "Ads"], ["export", "Export"]];

/** The owner's view of axol: who uses it, what they do and type, and what looks worth changing. */
export default function Admin({ user, onOwner }) {
  const [section, setSection] = useState("overview");
  const [userId, setUserId] = useState(null);
  const openUser = useCallback((id) => { if (id) { setUserId(id); setSection("users"); document.querySelector(".page")?.scrollTo(0, 0); } }, []);
  const pick = (id) => { setSection(id); setUserId(null); };

  return (
    <div className="page">
      <div className="shell xwide fade-in">
        <div>
          <h1>Owner</h1>
          <p className="muted" style={{ margin: "6px 0 0" }}>Everyone using axol, everything they type and do, and what the numbers say you should change.</p>
        </div>
        {!user.admin ? <Claim onOwner={onOwner} /> : (
          <>
            <div className="chips" role="tablist">{SECTIONS.map(([id, label]) => <button key={id} role="tab" aria-selected={section === id} className={`chip ${section === id ? "on" : ""}`} onClick={() => pick(id)}>{label}</button>)}</div>
            {section === "overview" && <Overview openUser={openUser} />}
            {section === "users" && (userId ? <UserDetail id={userId} back={() => setUserId(null)} openUser={openUser} /> : <Users openUser={openUser} />)}
            {section === "activity" && <Activity openUser={openUser} />}
            {section === "feedback" && <Feedback openUser={openUser} />}
            {section === "ads" && <Ads openUser={openUser} />}
            {section === "export" && <Export />}
          </>
        )}
      </div>
    </div>
  );
}
