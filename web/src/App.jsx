import React, { useCallback, useEffect, useState } from "react";
import { api, getToken, setToken } from "./lib/api.js";
import Auth from "./pages/Auth.jsx";
import Onboarding from "./pages/Onboarding.jsx";
import Feed from "./pages/Feed.jsx";
import Search from "./pages/Search.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Profile from "./pages/Profile.jsx";
import { Reels, Search as SearchIcon, Chart, User } from "./components/Icons.jsx";

const TABS = [
  { id: "reels", label: "Reels", Icon: Reels },
  { id: "search", label: "Search", Icon: SearchIcon },
  { id: "dash", label: "Dashboard", Icon: Chart },
  { id: "you", label: "You", Icon: User },
];

export default function App() {
  const [state, setState] = useState({ loading: true, user: null, profile: null });
  const [tab, setTab] = useState("reels");
  const [searchPlaying, setSearchPlaying] = useState(false);
  // Each visit to a data tab remounts it, so the numbers are always current.
  const [visit, setVisit] = useState(0);

  useEffect(() => {
    if (!getToken()) return setState({ loading: false, user: null, profile: null });
    api.me().then((d) => setState({ loading: false, user: d.user, profile: d.profile }))
      .catch(() => { setToken(null); setState({ loading: false, user: null, profile: null }); });
  }, []);

  const onAuth = (d) => { setToken(d.token); setState({ loading: false, user: d.user, profile: d.profile }); };
  const onProfile = (profile) => setState((s) => ({ ...s, profile }));
  const logout = async () => { await api.logout().catch(() => {}); setToken(null); setTab("reels"); setState({ loading: false, user: null, profile: null }); };
  const go = useCallback((id) => { setTab(id); setVisit((v) => v + 1); }, []);

  if (state.loading) return <div className="loading-slide"><div className="orb" /></div>;
  if (!state.user) return <Auth onAuth={onAuth} />;
  if (!state.profile?.onboarded) return <Onboarding onDone={onProfile} name={state.user.name} />;

  return (
    <div className="app">
      {/* The feed stays mounted behind the other tabs so it resumes exactly where it was. */}
      <Feed paused={tab !== "reels"} />
      {/* Search keeps its results while you look at other tabs. */}
      <div hidden={tab !== "search"}><Search onPlayerOpen={setSearchPlaying} /></div>
      {tab === "dash" && <Dashboard key={visit} user={state.user} onGoReels={() => go("reels")} />}
      {tab === "you" && <Profile key={visit} user={state.user} onLogout={logout} />}

      {!searchPlaying && (
        <nav className={`tabbar ${tab === "reels" ? "over-video" : ""}`} aria-label="Main">
          <div className="tabbrand"><span className="dot" />axol</div>
          {TABS.map(({ id, label, Icon }) => (
            <button key={id} className={`tab ${tab === id ? "on" : ""}`} onClick={() => go(id)} aria-current={tab === id ? "page" : undefined}>
              <Icon /><span>{label}</span>
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
