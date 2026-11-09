import { youtube } from "./youtube.js";
import { tiktok } from "./tiktok.js";
import { instagram } from "./instagram.js";

export const SOURCES = { youtube, tiktok, instagram };

export function sourceStatus() {
  return Object.fromEntries(Object.values(SOURCES).map((s) => [s.name, s.mode()]));
}

/** Detect which platform a pasted URL belongs to and normalize it. */
export function itemFromUrl(url) {
  for (const s of Object.values(SOURCES)) {
    const it = s.fromUrl(url);
    if (it) return it;
  }
  return null;
}
