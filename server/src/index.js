import express from "express";
import fs from "node:fs";
import { config } from "./config.js";
import { authRouter } from "./routes/auth.js";
import { apiRouter } from "./routes/api.js";
import { aiStatus } from "./ai/claude.js";
import { sourceStatus } from "./sources/index.js";
import { warmupCatalog, backfillTikTokFiles } from "./ingest.js";
import { cachePending } from "./media.js";
import { loadPromotions } from "./promotions.js";
import { db } from "./db.js";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "256kb" }));

app.use("/api/auth", authRouter);
app.use("/api", apiRouter);

// Serve the built web app in production.
if (fs.existsSync(config.webDist)) {
  app.use(express.static(config.webDist, { maxAge: "1h", index: false }));
  app.get("*", (_req, res) => res.sendFile(`${config.webDist}/index.html`));
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "something broke on our side" });
});

const server = app.listen(config.port, () => {
  const ai = aiStatus();
  console.log(`axol server on http://localhost:${config.port}`);
  console.log(`  ai: ${ai.enabled ? `on (${ai.model})` : `off — heuristics (${ai.reason || "no credentials"})`}`);
  console.log(`  sources: ${JSON.stringify(sourceStatus())}`);
  if (config.warmup) {
    const run = () => warmupCatalog().then((n) => n && console.log(`[warmup] added ${n} clips`)).catch((e) => console.warn("[warmup]", e.message))
      .then(() => cachePending()).then((n) => n && console.log(`[media] stored ${n} pending files`))
      .then(() => backfillTikTokFiles()).then((n) => n && console.log(`[backfill] stored ${n} TikTok files`));
    setTimeout(run, 2000);
    setInterval(run, 6 * 3600e3).unref();
  }
  // Promoted clips are scheduled from promotions.json on every boot, warm-up or not.
  loadPromotions().then((n) => n && console.log(`[promotions] ${n} scheduled`)).catch((e) => console.warn("[promotions]", e.message));
});

// Railway sends SIGTERM to the old container on every redeploy. Without a
// handler Node dies from the signal, `npm start` fails with "signal SIGTERM",
// and Railway reports the replaced deployment as crashed. Shut down cleanly.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, closing`);
  const done = () => {
    try { db.close(); } catch {}
    process.exit(0);
  };
  server.close(done);
  server.closeIdleConnections?.();
  setTimeout(done, 8000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
