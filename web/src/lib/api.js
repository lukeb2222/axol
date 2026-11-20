const TOKEN_KEY = "axol_token";
export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

async function call(method, path, body) {
  const headers = { "content-type": "application/json" };
  const t = getToken();
  if (t) headers.authorization = `Bearer ${t}`;
  const res = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, keepalive: method === "POST" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `request failed (${res.status})`), { status: res.status });
  return data;
}

export const api = {
  health: () => call("GET", "/health"),
  signup: (b) => call("POST", "/auth/signup", b),
  login: (b) => call("POST", "/auth/login", b),
  logout: () => call("POST", "/auth/logout"),
  me: () => call("GET", "/auth/me"),
  chips: () => call("GET", "/onboarding/chips"),
  onboard: (b) => call("POST", "/onboarding", b),
  feed: (n, start) => call("GET", `/feed?n=${n || 8}${start ? "&start=1" : ""}`),
  event: (b) => call("POST", "/events", b),
  profile: () => call("GET", "/profile"),
  refresh: () => call("POST", "/profile/refresh"),
  interest: (b) => call("POST", "/profile/interest", b),
  importLinks: (b) => call("POST", "/import", b),
  dashboard: () => call("GET", `/dashboard?tz=${-new Date().getTimezoneOffset()}`),
  // Catalog results for a query. `ids` in the response is the whole ordered list; page through it with searchItems.
  search: (q, { scope = "strong", n = 18, refresh = false } = {}) => call("GET", `/search?q=${encodeURIComponent(q)}&scope=${scope}&n=${n}${refresh ? "&refresh=1" : ""}`),
  searchItems: (q, ids) => call("POST", "/search/items", { q, ids }),
  discover: (q) => call("POST", "/search/discover", { q }),
  steer: (b) => call("POST", "/feed/steer", b),
  suggest: () => call("GET", "/search/suggest"),
  feedback: (text) => call("POST", "/feedback", { text }),
  referrals: () => call("GET", "/referrals"),
  submitAd: (url) => call("POST", "/referrals/ad", { url }),
  // Owner's data view.
  admin: {
    claim: (key) => call("POST", "/admin/claim", { key }),
    overview: () => call("GET", `/admin/overview?tz=${-new Date().getTimezoneOffset()}`),
    users: ({ q = "", sort = "newest", offset = 0 } = {}) => call("GET", `/admin/users?q=${encodeURIComponent(q)}&sort=${sort}&offset=${offset}`),
    user: (id) => call("GET", `/admin/users/${encodeURIComponent(id)}`),
    activity: ({ kind = "", before = "" } = {}) => call("GET", `/admin/activity?kind=${encodeURIComponent(kind)}${before ? `&before=${before}` : ""}`),
    feedback: () => call("GET", "/admin/feedback"),
    ads: () => call("GET", "/admin/ads"),
    decideAd: (id, action, note) => call("POST", `/admin/ads/${encodeURIComponent(id)}`, { action, note }),
    /** Fetch a CSV with the sign-in token and hand it to the browser as a download. */
    async download(name) {
      const res = await fetch(`/api/admin/export/${name}.csv`, { headers: { authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new Error(`export failed (${res.status})`);
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement("a"), { href: url, download: `axol-${name}-${new Date().toISOString().slice(0, 10)}.csv` });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    },
  },
};

/** Fire-and-forget event that survives page unload. */
export function beacon(body) {
  const t = getToken();
  try {
    return fetch("/api/events", {
      method: "POST", keepalive: true,
      headers: { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) },
      body: JSON.stringify(body),
    }).then((r) => r.json()).catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}
