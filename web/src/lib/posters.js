// Poster images shown under a player until it is actually playing, so a swipe never lands on black.
export function posterCandidates(item) {
  if (item.source === "youtube") {
    const id = item.externalId;
    // oar2 is the vertical frame YouTube generates for Shorts; hqdefault is the universal fallback.
    return [`https://i.ytimg.com/vi/${id}/oar2.jpg`, `https://i.ytimg.com/vi/${id}/hqdefault.jpg`];
  }
  return item.thumbnail ? [item.thumbnail] : [];
}
export function preloadPoster(item) {
  const [first] = posterCandidates(item);
  if (first) { const img = new Image(); img.decoding = "async"; img.src = first; }
}
