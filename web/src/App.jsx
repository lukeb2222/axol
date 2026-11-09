import React, { useEffect, useState } from "react";
import { api, getToken, setToken } from "./lib/api.js";
import Auth from "./pages/Auth.jsx";
import Onboarding from "./pages/Onboarding.jsx";
import Feed from "./pages/Feed.jsx";
import Profile from "./pages/Profile.jsx";

export default function App() {
  const [state, setState] = useState({ loading: true, user: null, profile: null });
  const [showProfile, setShowProfile] = useState(false);

  useEffect(() => {
    if (!getToken()) return setState({ loading: false, user: null, profile: null });
    api.me().then((d) => setState({ loading: false, user: d.user, profile: d.profile }))
      .catch(() => { setToken(null); setState({ loading: false, user: null, profile: null }); });
  }, []);

  const onAuth = (d) => { setToken(d.token); setState({ loading: false, user: d.user, profile: d.profile }); };
  const onProfile = (profile) => setState((s) => ({ ...s, profile }));
  const logout = async () => { await api.logout().catch(() => {}); setToken(null); setShowProfile(false); setState({ loading: false, user: null, profile: null }); };

  if (state.loading) return <div className="loading-slide"><div className="orb" /></div>;
  if (!state.user) return <Auth onAuth={onAuth} />;
  if (!state.profile?.onboarded) return <Onboarding onDone={onProfile} name={state.user.name} />;
  return (
    <>
      <Feed user={state.user} onOpenProfile={() => setShowProfile(true)} paused={showProfile} />
      {showProfile && <Profile user={state.user} onClose={() => setShowProfile(false)} onLogout={logout} onRetune={() => { setShowProfile(false); }} />}
    </>
  );
}
