import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { q, uid, now } from "./db.js";

export function hashPassword(pw) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(pw, salt, 64).toString("hex")}`;
}
export function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(":");
  const a = Buffer.from(hash, "hex");
  const b = scryptSync(pw, salt, 64);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createSession(userId) {
  const token = randomBytes(32).toString("base64url");
  q.run("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)", token, userId, now());
  return token;
}

export function userFromToken(token) {
  if (!token) return null;
  return q.get("SELECT u.id, u.email, u.display_name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?", token) || null;
}

export function readToken(req) {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7);
  const m = /(?:^|;\s*)axol_session=([^;]+)/.exec(req.headers.cookie || "");
  return m ? decodeURIComponent(m[1]) : null;
}

/** Express middleware: attaches req.user or 401s. */
export function requireAuth(req, res, next) {
  const user = userFromToken(readToken(req));
  if (!user) return res.status(401).json({ error: "not signed in" });
  req.user = user;
  next();
}

export function newUserId() {
  return uid();
}
