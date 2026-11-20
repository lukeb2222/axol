import React, { useEffect, useState } from "react";
import { api } from "../lib/api.js";

const STATE = { pending: "Waiting for review", running: "Running now", finished: "Finished", rejected: "Not approved", ended: "Ended" };
const day = (ms) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/**
 * Invite friends, earn an ad. Each member has ten single-use links. When one person joins through
 * a link and finishes setup, the member can submit one YouTube Short to run as a sponsored clip.
 */
export default function Invite() {
  const [d, setD] = useState(null);
  const [copied, setCopied] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => { api.referrals().then(setD).catch((e) => setErr(e.message)); }, []);
  if (!d) return err ? <div className="error">{err}</div> : null;

  const link = (code) => `${location.origin}/?invite=${code}`;
  const copy = async (code) => {
    const text = link(code);
    try {
      if (navigator.share && matchMedia("(pointer: coarse)").matches) await navigator.share({ title: "axol", text: "Join me on axol, a feed that's only for you.", url: text });
      else await navigator.clipboard.writeText(text);
      setCopied(code); setTimeout(() => setCopied(""), 1800);
    } catch {}
  };
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr("");
    try { setD(await api.submitAd(url)); setUrl(""); } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  };

  const open = d.invites.filter((i) => i.status === "open");
  const used = d.invites.filter((i) => i.status !== "open");
  const shown = showAll ? d.invites : [...used, ...open.slice(0, 1)];
  const earned = d.joined >= d.needed;

  return (
    <div className="card invite" data-testid="invite">
      <div className="tiny" style={{ marginBottom: 6 }}>INVITE FRIENDS</div>
      <h2>Bring one friend, get a free ad</h2>
      <p className="muted" style={{ margin: "6px 0 12px" }}>
        You have {d.invites.length} invite links, each good for one person. When {d.needed === 1 ? "one friend joins" : `${d.needed} friends join`} and sets up their feed,
        you can put one YouTube Short of your choice in front of axol viewers for {d.termDays} days.
      </p>

      <div className="invite-progress" data-testid="invite-progress">
        <strong>{d.joined}</strong> joined{used.length > d.joined ? ` · ${used.length - d.joined} signed up, still setting up` : ""} · {open.length} link{open.length === 1 ? "" : "s"} left
      </div>

      <div className="invite-list">
        {shown.map((i) => (
          <div className="invite-row" key={i.code}>
            <code>{link(i.code).replace(/^https?:\/\//, "")}</code>
            {i.status === "open"
              ? <button className="btn sm primary" onClick={() => copy(i.code)}>{copied === i.code ? "Copied" : "Copy link"}</button>
              : <span className={`badge ${i.status === "joined" ? "learned" : ""}`}>{i.status === "joined" ? `${i.name || "Friend"} joined` : `${i.name || "Friend"} signed up`}</span>}
          </div>
        ))}
      </div>
      {d.invites.length > shown.length && <button className="tiny" style={{ marginTop: 8 }} onClick={() => setShowAll(true)}>Show all {d.invites.length} links</button>}

      {d.adAvailable && (
        <form onSubmit={submit} className="adform" data-testid="adform">
          <h2>You've earned your ad</h2>
          <p className="muted" style={{ margin: 0 }}>Paste the YouTube Short you want to promote. axol reviews it, then it runs for {d.termDays} days with a button to the creator's channel.</p>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.youtube.com/shorts/…" inputMode="url" autoComplete="off" required />
          <button className="btn primary sm" disabled={busy || !url.trim()}>{busy && <span className="spin" />}Submit my ad</button>
        </form>
      )}
      {!d.adAvailable && !earned && <p className="tiny" style={{ marginTop: 12 }}>Your free ad unlocks as soon as one friend finishes setting up.</p>}
      {err && <div className="error" style={{ marginTop: 10 }}>{err}</div>}

      {d.ads.map((a) => (
        <div className="adstatus" key={a.id} data-testid="adstatus">
          {a.thumbnail && <img src={a.thumbnail} alt="" />}
          <div>
            <div className="adstate"><span className={`badge ${a.state === "running" ? "learned" : ""}`}>{STATE[a.state] || a.state}</span>{a.state === "running" && <span className="tiny">until {day(a.endsAt)}</span>}</div>
            <div className="adtitle">{a.title || a.url}</div>
            {a.state === "pending" && <div className="tiny">axol checks every ad before it runs. This usually takes a day.</div>}
            {a.state === "rejected" && <div className="tiny">{a.note ? `Reason: ${a.note}. ` : ""}You can submit a different video.</div>}
            {(a.state === "running" || a.state === "finished" || a.state === "ended") && <div className="tiny">Shown {a.shown} time{a.shown === 1 ? "" : "s"} to {a.viewers} {a.viewers === 1 ? "person" : "people"} · {a.finished} watched through · {a.clicks} channel tap{a.clicks === 1 ? "" : "s"}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
