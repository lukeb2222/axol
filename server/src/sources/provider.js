// Generic discovery provider hook for platforms without a public search API.
// Point AXOL_DISCOVERY_PROVIDER_URL at any service that answers
//   GET <url>?q=<query>&source=<tiktok|instagram>  ->  [{ "url": "...", "title"?: "...", "creator"?: "..." }]
// (e.g. a licensed data partner, your own crawler, or a scraping actor you are allowed to use).
import { config } from "../config.js";

export async function providerSearch(source, query, { max = 12 } = {}) {
  if (!config.discoveryProviderUrl) return [];
  const u = new URL(config.discoveryProviderUrl);
  u.searchParams.set("q", query);
  u.searchParams.set("source", source);
  u.searchParams.set("limit", String(max));
  const headers = config.discoveryProviderToken ? { authorization: `Bearer ${config.discoveryProviderToken}` } : {};
  const res = await fetch(u, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`discovery provider ${source} failed: ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : data.items || [];
}
