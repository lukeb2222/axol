import React from "react";
const P = (props) => ({ fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", viewBox: "0 0 24 24", ...props });
export const Heart = ({ filled, ...p }) => (
  <svg {...P(p)} fill={filled ? "currentColor" : "none"}><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z" /></svg>
);
export const EyeOff = (p) => <svg {...P(p)}><path d="M17.9 17.9A10 10 0 0 1 12 20c-7 0-11-8-11-8a18 18 0 0 1 5.1-6M9.9 4.2A9 9 0 0 1 12 4c7 0 11 8 11 8a18 18 0 0 1-2.2 3.2M1 1l22 22" /><path d="M9.9 9.9a3 3 0 1 0 4.2 4.2" /></svg>;
export const Share = (p) => <svg {...P(p)}><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13" /></svg>;
export const Info = (p) => <svg {...P(p)}><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></svg>;
export const Volume = ({ muted, ...p }) => (
  <svg {...P(p)}><path d="M11 5 6 9H2v6h4l5 4z" />{muted ? <path d="M23 9l-6 6M17 9l6 6" /> : <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" />}</svg>
);
export const Play = (p) => <svg {...P(p)} fill="currentColor" stroke="none"><path d="M7 4v16l13-8z" /></svg>;
export const Sparkle = (p) => <svg {...P(p)} fill="currentColor" stroke="none"><path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z" /></svg>;
export const ChevronUp = (p) => <svg {...P(p)}><path d="m18 15-6-6-6 6" /></svg>;
export const X = (p) => <svg {...P(p)}><path d="M18 6 6 18M6 6l12 12" /></svg>;
export const Refresh = (p) => <svg {...P(p)}><path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6" /></svg>;
export const Reels = (p) => <svg {...P(p)}><rect x="5" y="2.5" width="14" height="19" rx="3" /><path d="M10.5 9v6l5-3z" fill="currentColor" stroke="none" /></svg>;
export const Search = (p) => <svg {...P(p)}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.8-3.8" /></svg>;
export const Chart = (p) => <svg {...P(p)}><path d="M5 20V11M12 20V4M19 20v-6" /></svg>;
export const User = (p) => <svg {...P(p)}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>;
export const Back = (p) => <svg {...P(p)}><path d="m15 18-6-6 6-6" /></svg>;
export const Flame = (p) => <svg {...P(p)} fill="currentColor" stroke="none"><path d="M12 2c1 4 5 5.5 5 10.5A5 5 0 0 1 7 12.5c0-1.6.6-2.8 1.5-3.8.3 1.3 1 2 2 2.3C10 8 10.500 5 12 2z" /></svg>;
