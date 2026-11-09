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
  feed: (n) => call("GET", `/feed?n=${n || 8}`),
  event: (b) => call("POST", "/events", b),
  profile: () => call("GET", "/profile"),
  refresh: () => call("POST", "/profile/refresh"),
  interest: (b) => call("POST", "/profile/interest", b),
  importLinks: (b) => call("POST", "/import", b),
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
