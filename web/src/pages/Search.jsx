import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";
import ReelScroller from "../components/ReelScroller.jsx";
import Poster from "../components/Poster.jsx";
import { Search as SearchIcon, X } from "../components/Icons.jsx";

const LABEL = { youtube: "Shorts", tiktok: "TikTok", instagram: "Reels" };
const NAMES = { youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram" };
const RECENT_KEY = "axol_recent_searches";
const PAGE = 18;
const loadRecent = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch { return []; } };
const fmt = (ms) => (ms ? `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}` : "");
const pretty = (t) => t.replace(/-/g, " ");
const listNames = (names) => names.map((n) => NAMES[n] || n).join(names.length === 2 ? " and " : ", ").replace(/, ([^,]*)$/, " and $1");
const quote = (words) => words.map((w) => `“${w}”`).join(" or ");
const EMPTY = { ids: [], items: [], total: 0 };

/**
 * Search any topic.
 *
 * Results are the clips in axol's catalog that match the whole query. The number in the heading,
 * the grid, and the swipeable player are the same list: each is driven by the ordered ids the
 * server returned, and paging loads the next ids from that list.
 *
 * Two ways to widen a search are offered separately and never happen on their own:
 *   - clips that match only part of the query (shown under their own heading), and
 *   - a fresh search on the platforms, when their daily budget allows it.
 */
export default function Search({ onPlayerOpen }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("idle"); // idle | loading | done | error
  const [term, setTerm] = useState("");
  const [strong, setStrong] = useState(EMPTY);
  const [related, setRelated] = useState({ ...EMPTY, open: false, missing: [] });
  const [discovery, setDiscovery] = useState({ available: [], pending: [], paused: [], upToDate: [] });
  const [discovering, setDiscovering] = useState(false);
  const [error, setError] = useState("");
  const [suggest, setSuggest] = useState({ mine: [], popular: [] });
  const [recent, setRecent] = useState(loadRecent);
  const [player, setPlayer] = useState(null); // { list: "strong" | "related", start }
  const inputRef = useRef(null);
  const run = useRef(0);
  const paging = useRef(false);

  useEffect(() => { api.suggest().then(setSuggest).catch(() => {}); }, []);
  useEffect(() => { onPlayerOpen?.(!!player); }, [player, onPlayerOpen]);

  const apply = (d) => {
    setStrong({ ids: d.ids, items: d.items, total: d.total });
    setRelated({ ...EMPTY, open: false, total: d.relatedTotal, missing: d.relatedMissing || [] });
    setDiscovery(d.discovery);
  };

  const search = useCallback(async (text) => {
    const next = text.trim();
    if (next.length < 2) return;
    const id = ++run.current;
    setQ(next); setTerm(next); setStatus("loading"); setError(""); setStrong(EMPTY); setRelated({ ...EMPTY, open: false, missing: [] });
    inputRef.current?.blur();
    const list = [next, ...loadRecent().filter((r) => r.toLowerCase() !== next.toLowerCase())].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list)); setRecent(list);
    try {
      const d = await api.search(next);
      if (id !== run.current) return;
      apply(d); setStatus("done");
    } catch (e) {
      if (id === run.current) { setError(e.message); setStatus("error"); }
    }
  }, []);

  // Re-read the same search (after a fresh platform search lands) without re-recording it.
  const refresh = useCallback(async () => {
    const id = run.current;
    try {
      const d = await api.search(term, { refresh: true });
      if (id === run.current && !player) apply(d);
    } catch {}
  }, [term, player]);

  // A fresh search that is still running: look again shortly, while nothing is being watched.
  useEffect(() => {
    if (status !== "done" || !discovery.pending.length || player) return;
    const t = setTimeout(refresh, 12000);
    return () => clearTimeout(t);
  }, [status, discovery.pending, player, refresh]);

  const discover = async () => {
    setDiscovering(true);
    try {
      const d = await api.discover(term);
      setDiscovery(d);
      await refresh();
    } catch (e) { setError(e.message); } finally { setDiscovering(false); }
  };

  const showRelated = async () => {
    try {
      const d = await api.search(term, { scope: "related", refresh: true });
      setRelated({ open: true, ids: d.ids, items: d.items, total: d.total, missing: d.relatedMissing || [] });
    } catch (e) { setError(e.message); }
  };

  // Paging takes the next ids from the list already shown, so it can never leave that list.
  const loadMore = useCallback(async (which) => {
    const list = which === "related" ? related : strong;
    const next = list.ids.slice(list.items.length, list.items.length + PAGE);
    if (!next.length || paging.current) return;
    paging.current = true;
    try {
      const d = await api.searchItems(term, next);
      const set = which === "related" ? setRelated : setStrong;
      set((s) => { const have = new Set(s.items.map((i) => i.id)); return { ...s, items: [...s.items, ...d.items.filter((i) => !have.has(i.id))] }; });
    } catch {} finally { paging.current = false; }
  }, [strong, related, term]);

  const removeFrom = useCallback((which) => (impressionId) => {
    (which === "related" ? setRelated : setStrong)((s) => ({ ...s, items: s.items.filter((i) => i.impressionId !== impressionId) }));
  }, []);
  // Steering from a search result changes the feed's preferences; the result list stays as shown.
  const steerFromSearch = useCallback((payload) => api.steer({ ...payload, queue: [], replan: false }), []);

  const clear = () => { run.current++; setQ(""); setTerm(""); setStatus("idle"); setStrong(EMPTY); setRelated({ ...EMPTY, open: false, missing: [] }); inputRef.current?.focus(); };

  const renderGrid = (which, list) => (
    <>
      <div className="grid">
        {list.items.map((it, i) => (
          <button key={it.impressionId} className="tile" onClick={() => setPlayer({ list: which, start: i })}>
            <div className="tilebg" />
            <Poster item={it} className="tileimg" />
            <div className="tileshade" />
            <span className={`srcpill ${it.source}`}>{LABEL[it.source]}</span>
            {it.durationMs > 0 && <span className="dur">{fmt(it.durationMs)}</span>}
            <span className="tiletitle">{it.title || it.creator || pretty(it.tags?.[0] || "")}</span>
          </button>
        ))}
      </div>
      {list.items.length < list.ids.length && <button className="btn ghost" onClick={() => loadMore(which)}>Show more ({list.ids.length - list.items.length} left)</button>}
    </>
  );

  const playing = player ? (player.list === "related" ? related : strong) : null;
  const canDiscover = discovery.available.length > 0;
  const busyDiscovering = discovering || discovery.pending.length > 0;

  return (
    <div className="page">
      <div className="shell wide">
        <form className="searchbar" onSubmit={(e) => { e.preventDefault(); search(q); }} role="search">
          <SearchIcon />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search any topic" aria-label="Search any topic" enterKeyHint="search" autoComplete="off" />
          {q && <button type="button" className="clear" onClick={clear} aria-label="Clear"><X /></button>}
        </form>

        {status === "idle" && (
          <div className="fade-in" style={{ display: "grid", gap: 22 }}>
            {recent.length > 0 && (
              <div>
                <div className="row between" style={{ marginBottom: 10 }}><h2>Recent</h2><button className="tiny" onClick={() => { localStorage.removeItem(RECENT_KEY); setRecent([]); }}>Clear</button></div>
                <div className="chips">{recent.map((r) => <button key={r} className="chip" onClick={() => search(r)}>{r}</button>)}</div>
              </div>
            )}
            {suggest.mine.length > 0 && (
              <div>
                <h2 style={{ marginBottom: 10 }}>Your topics</h2>
                <div className="chips">{suggest.mine.map((t) => <button key={t} className="chip" onClick={() => search(pretty(t))}>{pretty(t)}</button>)}</div>
              </div>
            )}
            {suggest.popular.length > 0 && (
              <div>
                <h2 style={{ marginBottom: 10 }}>Popular right now</h2>
                <div className="chips">{suggest.popular.map((t) => <button key={t} className="chip" onClick={() => search(pretty(t))}>{pretty(t)}</button>)}</div>
              </div>
            )}
            <p className="tiny">Searching also teaches your feed. Look something up and more of it starts showing up in your reels.</p>
          </div>
        )}

        {status === "loading" && <div className="grid">{Array.from({ length: 6 }, (_, i) => <div key={i} className="tile"><div className="shimmer" /></div>)}</div>}
        {error && <div className="error">{error}</div>}

        {status === "done" && (
          <div className="fade-in" style={{ display: "grid", gap: 14 }}>
            <h2 data-testid="result-heading">
              {strong.total > 0 ? `${strong.total} clip${strong.total === 1 ? "" : "s"} for “${term}”` : `No clips match “${term}” yet`}
            </h2>
            {strong.total === 0 && <p className="muted" style={{ margin: 0 }}>axol only shows clips that are actually about your search, and it doesn't have one for this yet. Your search is saved, so your feed will look for it.</p>}
            {strong.total > 0 && renderGrid("strong", strong)}

            <div className="broaden" data-testid="broaden">
              <div className="broaden-head">Want more?</div>
              {related.total > 0 && !related.open && (
                <div className="broaden-row">
                  <span>{related.total === 1 ? "1 clip matches" : `${related.total} clips match`} part of your search{related.missing.length ? ` but not ${quote(related.missing)}` : ""}.</span>
                  <button className="btn sm ghost" onClick={showRelated}>Show related clips</button>
                </div>
              )}
              {canDiscover && (
                <div className="broaden-row">
                  <span>Look for new clips about this on {listNames(discovery.available)}. It takes a moment.</span>
                  <button className="btn sm ghost" onClick={discover} disabled={busyDiscovering}>{busyDiscovering && <span className="spin light" />}Search for fresh clips</button>
                </div>
              )}
              {discovery.pending.length > 0 && <div className="broaden-row"><span><span className="spin light" style={{ display: "inline-block", verticalAlign: "-3px", marginRight: 8 }} />Looking on {listNames(discovery.pending)}. New matches will appear above.</span></div>}
              {discovery.paused.length > 0 && (
                <div className="broaden-row" data-testid="paused"><span>Fresh searches on {listNames(discovery.paused)} are paused until tomorrow: today's limit is used up. What you see is everything axol already has for this.</span></div>
              )}
              {!canDiscover && !discovery.pending.length && !discovery.paused.length && discovery.upToDate.length > 0 && (
                <div className="broaden-row"><span>axol already searched {listNames(discovery.upToDate)} for this today, so there is nothing newer to fetch yet.</span></div>
              )}
              {related.total === 0 && !canDiscover && !discovery.pending.length && !discovery.paused.length && !discovery.upToDate.length && (
                <div className="broaden-row"><span>Nothing else to add right now.</span></div>
              )}
            </div>

            {related.open && (
              <div className="fade-in" style={{ display: "grid", gap: 12 }} data-testid="related">
                <h2>Related, not exact</h2>
                <p className="muted" style={{ margin: 0 }}>These match part of “{term}”{related.missing.length ? `, but not ${quote(related.missing)}` : ""}.</p>
                {renderGrid("related", related)}
              </div>
            )}
          </div>
        )}
      </div>

      {player && playing && (
        <ReelScroller overlay items={playing.items} startIndex={player.start} onNeedMore={() => loadMore(player.list)} onRemove={removeFrom(player.list)}
          onSteer={steerFromSearch} onClose={() => setPlayer(null)} title={`“${term}”${player.list === "related" ? " · related" : ""}`}
          tail={playing.items.length < playing.ids.length ? <div className="loading-slide"><div className="skeleton"><div className="shimmer" /><p className="muted">More results…</p></div></div> : null} />
      )}
    </div>
  );
}
