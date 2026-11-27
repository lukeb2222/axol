// A short window after a hands-free scroll in which the viewer can go back one clip.

export const UNDO_MS = 2500;

/** Remember a move from `from` to `to` if it actually changed clips. */
export function rememberUndo(from, to, t = Date.now(), ttl = UNDO_MS) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return null;
  return { from, to, until: t + ttl };
}

/** The clip to return to, or null if the window has closed. */
export function undoTarget(state, t = Date.now()) {
  if (!state || t >= state.until) return null;
  return state.from;
}
