// Local media cache. Clips whose file can be fetched (TikTok via Apify downloads, Instagram reels
// via the file URL the scraper returns) are stored on the server's disk and served from axol
// itself, so they play in axol's own player: instant start, preloadable, real sound control, and
// no dependence on a platform embed loading. Files are served with HTTP range support, which
// iOS Safari requires for video.
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { config } from "./config.js";
import { db, q, now } from "./db.js";

export const MEDIA_DIR = config.mediaDir;
if (MEDIA_DIR) fs.mkdirSync(MEDIA_DIR, { recursive: true });

const MAX_FILE_BYTES = 60 * 1024 * 1024;
const inflight = new Map(); // video id -> Promise<filename|null>

export const mediaEnabled = () => !!MEDIA_DIR && config.mediaMaxMb > 0;
export const fileFor = (name) => path.join(MEDIA_DIR, name);
export const hasFile = (v) => !!v.media_file && fs.existsSync(fileFor(v.media_file));

/** Download one clip's file to disk. Resolves to the stored filename, or null if it failed. */
export function cacheMedia(video) {
  if (!mediaEnabled() || !video.media_src) return Promise.resolve(null);
  if (hasFile(video)) return Promise.resolve(video.media_file);
  if (inflight.has(video.id)) return inflight.get(video.id);
  const p = (async () => {
    const name = `${video.source}-${video.external_id.replace(/[^A-Za-z0-9_-]/g, "")}.mp4`;
    const tmp = fileFor(`${name}.part`);
    try {
      const res = await fetch(video.media_src, { signal: AbortSignal.timeout(60e3), headers: { "user-agent": "Mozilla/5.0 (axol media cache)" } });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const type = res.headers.get("content-type") || "";
      if (!/video|octet-stream/.test(type)) throw new Error(`unexpected content-type ${type}`);
      const declared = Number(res.headers.get("content-length") || 0);
      if (declared > MAX_FILE_BYTES) throw new Error("file too large");
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
      const bytes = fs.statSync(tmp).size;
      if (bytes < 10_000 || bytes > MAX_FILE_BYTES) throw new Error(`bad size ${bytes}`);
      fs.renameSync(tmp, fileFor(name));
      q.run("UPDATE videos SET media_file = ?, media_bytes = ?, media_at = ? WHERE id = ?", name, bytes, now(), video.id);
      evictIfNeeded();
      return name;
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      // A source that will not download (expired link, blocked host) is not retried forever.
      q.run("UPDATE videos SET media_fails = media_fails + 1 WHERE id = ?", video.id);
      console.warn(`[media] ${video.source} ${video.external_id}: ${e.message}`);
      return null;
    }
  })().finally(() => inflight.delete(video.id));
  inflight.set(video.id, p);
  return p;
}

/** Cache every not-yet-cached clip among these ids, a few at a time. */
export async function cacheMany(ids, { concurrency = 3 } = {}) {
  if (!mediaEnabled() || !ids.length) return 0;
  const rows = q.all(`SELECT * FROM videos WHERE id IN (${ids.map(() => "?").join(",")}) AND media_src != '' AND media_fails < 3`, ...ids).filter((v) => !hasFile(v));
  let done = 0, i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
    while (i < rows.length) { if (await cacheMedia(rows[i++])) done++; }
  }));
  return done;
}

/** Keep the cache under its size budget by dropping the least recently watched files. */
export function evictIfNeeded() {
  const budget = config.mediaMaxMb * 1024 * 1024;
  let total = q.get("SELECT COALESCE(SUM(media_bytes), 0) AS n FROM videos WHERE media_file != ''")?.n || 0;
  if (total <= budget) return;
  const clear = db.prepare("UPDATE videos SET media_file = '', media_bytes = 0 WHERE id = ?");
  for (const v of q.all("SELECT id, media_file, media_bytes FROM videos WHERE media_file != '' ORDER BY media_at ASC LIMIT 200")) {
    if (total <= budget * 0.9) break;
    fs.rmSync(fileFor(v.media_file), { force: true });
    clear.run(v.id);
    total -= v.media_bytes;
  }
}

export function mediaStats() {
  if (!mediaEnabled()) return null;
  const rows = q.all("SELECT source, COUNT(*) AS n, COALESCE(SUM(media_bytes), 0) AS bytes FROM videos WHERE media_file != '' GROUP BY source");
  return {
    files: Object.fromEntries(rows.map((r) => [r.source, r.n])),
    usedMb: Math.round(rows.reduce((s, r) => s + r.bytes, 0) / 1048576),
    budgetMb: config.mediaMaxMb,
  };
}

/** Express handler: GET /api/media/:id.mp4 */
export async function serveMedia(req, res) {
  const id = String(req.params.id || "").replace(/\.mp4$/, "");
  const v = q.get("SELECT * FROM videos WHERE id = ?", id);
  if (!v || !mediaEnabled()) return res.status(404).end();
  let name = hasFile(v) ? v.media_file : null;
  if (!name && v.media_src && v.media_fails < 3) name = await cacheMedia(v); // evicted earlier: fetch again
  if (!name) return res.status(404).end();
  if (now() - (v.media_at || 0) > 60e3) q.run("UPDATE videos SET media_at = ? WHERE id = ?", now(), v.id);
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.type("video/mp4");
  res.sendFile(fileFor(name), { acceptRanges: true });
}
