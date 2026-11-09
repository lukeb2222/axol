import express from "express";
import fs from "node:fs";
import { config } from "./config.js";
import { authRouter } from "./routes/auth.js";
import { apiRouter } from "./routes/api.js";
import { aiStatus } from "./ai/claude.js";
import { sourceStatus } from "./sources/index.js";

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

app.listen(config.port, () => {
  const ai = aiStatus();
  console.log(`axol server on http://localhost:${config.port}`);
  console.log(`  ai: ${ai.enabled ? `on (${ai.model})` : `off — heuristics (${ai.reason || "no credentials"})`}`);
  console.log(`  sources: ${JSON.stringify(sourceStatus())}`);
});
