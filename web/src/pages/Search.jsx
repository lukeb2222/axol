import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";
import ReelScroller from "../components/ReelScroller.jsx";
import Poster from "../components/Poster.jsx";
import { Search as SearchIcon, X } from "../components/Icons.jsx";

const LABEL = { youtube: "Shorts", tiktok: "TikTok", instagram: "Reels" };
const NAMES = { youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram" };
const RECENT_KEY = "axol_recent_searches";
const loadRecent = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch { return []; } };
const fmt = (ms) => (ms ? `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}` : "");

/**
 * Search any topic. Results come from the shared catalog immediately; a search for something new
 * also sends fresh queries to all three platforms, and those results join the grid as they land.
 * Playing a result opens the same reel player, and what you watch there trains your feed too.
 */
export default function Search({ onPlayerOpen }) {
  const [q, setQ] = useState("");
  const [state, setState] = useState({ status: "idle", q: "", items: [], total: 0, hasMore: false, pending: [], paused: [] });
  const [suggest, setSuggest] = useState({ mine: [], popular: [] });
  const [recent, setRecent] = useState(loadRecent);
  const [player, setPlayer] = useState(null); // { start }
  const inputRef = useRef(null);
  const run = useRef(0);
  const loadingMore = useRef(false);

  useEffect(() => { api.suggest().then(setSuggest).catch(() => {}); }, []);
  useEffect(() => { onPlayerOpen?.(!!player); }, [player, onPlayerOpen]);

  const search = useCallback(async (text) => {
    const term = text.trim();
    if (term.length < 2) return;
    const id = ++run.current;
    setQ(term);
    inputRef.current?.blur();
    setState((s) => ({ ...s, status: "loading", q: term, items: s.q === term ? s.items : [] }));
    const next = [term, ...loadRecent().filter((r) => r.toLowerCase() !== term.toLowerCase())].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next)); setRecent(next);
    try {
      const d = await api.search(term);
      if (id !== run.current) return;
      setState({ status: "done", q: term, items: d.items, total: d.total, hasMore: d.hasMore, pending: d.pending || [], paused: d.paused || [] });
    } catch (e) {
      if (id === run.current) setState((s) => ({ ...s, status: "error", error: e.message }));
    }
  }, []);

  // Slower platforms finish after the first response: fold their results in when they arrive.
  useEffect(() => {
    if (state.status !== "done" || !state.pending.length || player) return;
    const id = run.current;
    const t = setTimeout(async () => {
      try {
        const d = await api.search(state.q, { refresh: true });
        if (id !== run.current) return;
        setState((s) => {
          const have = new Set(s.items.map((i) => i.id));
          const fresh = d.items.filter((i) => !have.has(i.id));
          return { ...s, items: [...s.items, ...fresh], total: Math.max(s.total, d.total), hasMore: d.hasMore, pending: d.pending || [] };
        });
      } catch {}
    }, 14000);
    return () => clearTimeout(t);
  }, [state.status, state.pending, state.q, state.items.length, player]);

  const loadMore = useCallback(async () => {
    if (loadingMore.current || !state.hasMore) return;
    loadingMore.current = true;
    try {
      const d = await api.search(state.q, { offset: state.items.length, refresh: true });
      setState((s) => {
        const have = new Set(s.items.map((i) => i.id));
        return { ...s, items: [...s.items, ...d.items.filter((i) => !have.has(i.id))], hasMore: d.hasMore };
      });
    } catch {} finally { loadingMore.current = false; }
  }, [state.q, state.items.length, state.hasMore]);

  const onRemove = useCallback((impressionId) => setState((s) => ({ ...s, items: s.items.filter((i) => i.impressionId !== impressionId) })), []);
  const clear = () => { run.current++; setQ(""); setState({ status: "idle", q: "", items: [], total: 0, hasMore: false, pending: [], paused: [] }); inputRef.current?.focus(); };
  const pretty = (t) => t.replace(/-/g, " ");
  const list = (names) => names.map((n) => NAMES[n] || n).join(" and ");

  return (
    <div className="page">
      <div className="shell wide">
        <form className="searchbar" onSubmit={(e) => { e.preventDefault(); search(q); }} role="search">
          <SearchIcon />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search any topic" aria-label="Search any topic" enterKeyHint="search" autoComplete="off" />
          {q && <button type="button" className="clear" onClick={clear} aria-label="Clear"><X /></button>}
        </form>

        {state.status === "idle" && (
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

        {state.status === "loading" && !state.items.length && (
          <div className="grid">{Array.from({ length: 6 }, (_, i) => <div key={i} className="tile"><div className="shimmer" /></div>)}</div>
        )}
        {state.status === "error" && <div className="error">{state.error}</div>}

        {(state.status === "done" || state.items.length > 0) && (
          <div className="fade-in" style={{ display: "grid", gap: 14 }}>
            <div className="row between">
              <h2>{state.items.length ? `${state.total} clip${state.total === 1 ? "" : "s"} for "${state.q}"` : `Nothing yet for "${state.q}"`}</h2>
            </div>
            {state.pending.length > 0 && <div className="notice"><span className="spin light" />Fetching fresh clips from {list(state.pending)}. They'll appear here in a moment.</div>}
            {state.pending.length === 0 && state.paused.length > 0 && (
              <div className="notice">Fresh searches on {list(state.paused)} are paused until tomorrow's quota. Showing what's already in the catalog.</div>
            )}
            {!state.items.length && !state.pending.length && <p className="muted">Try a broader word, or check back soon. Your search has been added to what axol looks for.</p>}
            <div className="grid">
              {state.items.map((it, i) => (
                <button key={it.impressionId} className="tile" onClick={() => setPlayer({ start: i })}>
                  <div className="tilebg" />
                  <Poster item={it} className="tileimg" />
                  <div className="tileshade" />
                  <span className={`srcpill ${it.source}`}>{LABEL[it.source]}</span>
                  {it.durationMs > 0 && <span className="dur">{fmt(it.durationMs)}</span>}
                  <span className="tiletitle">{it.title || it.creator || pretty(it.tags?.[0] || "")}</span>
                </button>
              ))}
            </div>
            {state.hasMore && <button className="btn ghost" onClick={loadMore}>Show more</button>}
          </div>
        )}
      </div>

      {player && (
        <ReelScroller overlay items={state.items} startIndex={player.start} onNeedMore={loadMore} onRemove={onRemove}
          onClose={() => setPlayer(null)} title={`“${state.q}”`}
          tail={state.hasMore ? <div className="loading-slide"><div className="skeleton"><div className="shimmer" /><p className="muted">More on the way…</p></div></div> : null} />
      )}
    </div>
  );
}
