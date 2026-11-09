// Loads the official YouTube IFrame Player API once and resolves with window.YT.
let pending = null;
export function loadYT() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (pending) return pending;
  pending = new Promise((resolve) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT); };
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.async = true;
    document.head.appendChild(s);
  });
  return pending;
}

// Global sound preference: browsers only allow unmuted autoplay after a gesture,
// so we start muted and flip every player once the user taps the sound pill.
export const sound = {
  get on() { return localStorage.getItem("axol_sound") === "1"; },
  set on(v) { localStorage.setItem("axol_sound", v ? "1" : "0"); window.dispatchEvent(new Event("axol:sound")); },
};
