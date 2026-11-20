// The activity log: one row for each thing a person does or types outside of watching
// (sign-up, onboarding answers, searches, pasted links, steering, feedback, …).
// Watching itself is recorded in `impressions` and `events`. Passwords are never logged.
import { q, now } from "./db.js";

export function track(userId, kind, data = {}) {
  try {
    q.run("INSERT INTO activity (user_id, kind, data_json, created_at) VALUES (?, ?, ?, ?)", userId, String(kind), JSON.stringify(data ?? {}).slice(0, 8000), now());
  } catch (e) {
    console.warn("[activity]", e.message); // tracking must never break the request it describes
  }
}
