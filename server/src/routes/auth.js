import { Router } from "express";
import { q, now } from "../db.js";
import { hashPassword, verifyPassword, createSession, newUserId, requireAuth, readToken } from "../auth.js";
import { getProfile } from "../profileService.js";

export const authRouter = Router();

function setCookie(res, token) {
  res.setHeader("Set-Cookie", `axol_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 90}`);
}

authRouter.post("/signup", (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const name = String(req.body?.name || "").trim() || email.split("@")[0];
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "enter a valid email" });
  if (password.length < 6) return res.status(400).json({ error: "password needs 6+ characters" });
  if (q.get("SELECT 1 FROM users WHERE email = ?", email)) return res.status(409).json({ error: "that email already has an account" });
  const id = newUserId();
  q.run("INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)", id, email, hashPassword(password), name, now());
  q.run("INSERT INTO profiles (user_id, updated_at) VALUES (?, ?)", id, now());
  const token = createSession(id);
  setCookie(res, token);
  res.json({ token, user: { id, email, name }, profile: getProfile(id) });
});

authRouter.post("/login", (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const row = q.get("SELECT * FROM users WHERE email = ?", email);
  if (!row || !verifyPassword(String(req.body?.password || ""), row.password_hash)) {
    return res.status(401).json({ error: "wrong email or password" });
  }
  const token = createSession(row.id);
  setCookie(res, token);
  res.json({ token, user: { id: row.id, email: row.email, name: row.display_name }, profile: getProfile(row.id) });
});

authRouter.post("/logout", (req, res) => {
  const t = readToken(req);
  if (t) q.run("DELETE FROM sessions WHERE token = ?", t);
  res.setHeader("Set-Cookie", "axol_session=; Path=/; HttpOnly; Max-Age=0");
  res.json({ ok: true });
});

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ user: { id: req.user.id, email: req.user.email, name: req.user.display_name }, profile: getProfile(req.user.id) });
});
