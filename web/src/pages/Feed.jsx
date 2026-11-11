import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";
import ReelScroller from "../components/ReelScroller.jsx";

/** The personal feed: an endless ranked stream, fetched a batch ahead of the viewer. */
export default function Feed({ paused }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [empty, setEmpty] = useState(false);
  const [discoveryReady, setDiscoveryReady] = useState(true);
  const [links, setLinks] = useState("");
  const [importing, setImporting] = useState(false);
  const fetching = useRef(false);

  const fetchMore = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    try {
      const d = await api.feed(8);
      if (typeof d.discoveryReady === "boolean") setDiscoveryReady(d.discoveryReady);
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.impressionId));
        const seenVideos = new Set(prev.map((i) => i.id));
        const next = d.items.filter((i) => !seen.has(i.impressionId) && !seenVideos.has(i.id));
        setEmpty(!next.length && !prev.length);
        return [...prev, ...next];
      });
    } catch (e) {
      console.warn(e);
    } finally {
      fetching.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchMore(); }, [fetchMore]);
  // While discovery is still filling an empty catalog, keep checking quietly.
  useEffect(() => {
    if (!empty || !discoveryReady) return;
    const t = setTimeout(fetchMore, 6000);
    return () => clearTimeout(t);
  }, [empty, discoveryReady, fetchMore, items.length]);

  const onRemove = useCallback((impressionId) => setItems((prev) => prev.filter((i) => i.impressionId !== impressionId)), []);
  const retry = () => { setEmpty(false); setLoading(true); fetchMore(); };
  const doImport = async () => {
    setImporting(true);
    try { await api.importLinks({ text: links }); setLinks(""); retry(); } catch (e) { console.warn(e); } finally { setImporting(false); }
  };

  const tail = (
    <div className="loading-slide">
      {empty ? (
        <div style={{ display: "grid", gap: 12, maxWidth: 360, justifyItems: "center" }}>
          <div className="orb" />
          <h2>{discoveryReady ? "Building your feed" : "Discovery is warming up"}</h2>
          <p className="muted">
            {discoveryReady
              ? "Searching three platforms for clips that fit you. This takes a few seconds the first time."
              : "Video discovery isn't connected on this server yet. You can still add clips by pasting links."}
          </p>
          {discoveryReady ? (
            <button className="btn sm ghost" onClick={retry}>Refresh</button>
          ) : (
            <>
              <textarea style={{ minHeight: 70 }} value={links} onChange={(e) => setLinks(e.target.value)} placeholder="Paste a few video links…" />
              <div className="row" style={{ justifyContent: "center" }}>
                <button className="btn sm primary" onClick={doImport} disabled={!links.trim() || importing}>{importing && <span className="spin" />}Add clips</button>
                <button className="btn sm ghost" onClick={retry}>Try again</button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="skeleton"><div className="shimmer" /><p className="muted">{loading ? "Lining up your next clips…" : "Finding more for you…"}</p></div>
      )}
    </div>
  );

  return <ReelScroller items={items} onNeedMore={fetchMore} onRemove={onRemove} paused={paused} tail={tail} />;
}
