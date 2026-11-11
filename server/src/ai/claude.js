// Thin wrapper around the Anthropic SDK. Every caller supplies a heuristic
// fallback, so a missing key, a refusal, a spent budget, or a network error never breaks the app.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { config } from "../config.js";
import { q } from "../db.js";

let client = null;
const hasCredentials = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE || process.env.ANTHROPIC_FEDERATION_RULE_ID);
let disabledReason = config.aiDisabled ? "AXOL_DISABLE_AI=1" : hasCredentials ? null : "no Anthropic credentials set (ANTHROPIC_API_KEY)";
let lastCall = null; // { ok, model, at, error? } — surfaced in /api/health so a bad key is visible

// USD per million tokens [input, output]. Unknown models are costed at the highest rate here (conservative).
const PRICES = {
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-sonnet-5-5": [2, 10],
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-fable-5-1": [10, 50],
};
// Models that accept the server-side refusal fallback (`fallbacks: "default"`). Haiku 5.5 does not.
const SERVER_FALLBACK = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1"]);

const month = () => new Date().toISOString().slice(0, 7);
export const aiSpendUsd = () => (q.get("SELECT units FROM quota_ledger WHERE source = 'ai' AND day = ?", month())?.units || 0) / 1e6;
function recordSpend(model, usage) {
  const [pin, pout] = PRICES[model] || PRICES["claude-fable-5-1"];
  const inTok = (usage?.input_tokens || 0) + 1.25 * (usage?.cache_creation_input_tokens || 0) + 0.1 * (usage?.cache_read_input_tokens || 0);
  const micro = Math.ceil(inTok * pin + (usage?.output_tokens || 0) * pout); // (tokens × $/MTok) = micro-dollars
  q.run("INSERT INTO quota_ledger (source, day, units) VALUES ('ai', ?, ?) ON CONFLICT(source, day) DO UPDATE SET units = units + excluded.units", month(), micro);
}

function getClient() {
  if (disabledReason) return null;
  if (!client) {
    try {
      client = new Anthropic();
    } catch (e) {
      disabledReason = e.message;
      return null;
    }
  }
  return client;
}

export function aiStatus() {
  const c = getClient();
  const spent = aiSpendUsd();
  return {
    enabled: !!c && spent < config.aiMonthlyUsd,
    model: config.model,
    reason: disabledReason || (spent >= config.aiMonthlyUsd ? "monthly AI budget reached; using heuristics until next month" : null),
    monthSpendUsd: Math.round(spent * 1000) / 1000,
    monthBudgetUsd: config.aiMonthlyUsd,
    lastCall,
  };
}

/**
 * Ask Claude for a JSON object matching `schema` (a zod schema).
 * Returns the parsed object, or null when AI is unavailable / over budget / refused / failed.
 */
export async function structured({ schema, system, user, effort = "medium", maxTokens = 8000, model = config.model }) {
  const c = getClient();
  if (!c) return null;
  if (aiSpendUsd() >= config.aiMonthlyUsd) return null;

  const base = {
    model,
    max_tokens: maxTokens,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
    output_config: { effort, format: zodOutputFormat(schema) },
  };
  // Where supported, a safety decline is re-run on a fallback model inside the same call.
  const withFallback = () => c.beta.messages.parse({ ...base, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
  const plain = () => c.messages.parse(base);

  try {
    let res;
    if (SERVER_FALLBACK.has(model)) {
      try {
        res = await withFallback();
      } catch (e) {
        // If the fallback beta is rejected for this account/model, the plain request still works.
        if (!(e instanceof Anthropic.BadRequestError)) throw e;
        res = await plain();
      }
    } else {
      res = await plain();
    }
    recordSpend(res.model || model, res.usage);
    if (res.stop_reason === "refusal") {
      lastCall = { ok: false, model, at: Date.now(), error: `refusal (${res.stop_details?.category || "unspecified"})` };
      return null;
    }
    lastCall = { ok: true, model: res.model || model, at: Date.now() };
    return res.parsed_output ?? null;
  } catch (e) {
    let msg;
    if (e instanceof Anthropic.AuthenticationError) {
      msg = "invalid Anthropic API key";
      disabledReason = `${msg}; running on heuristics`;
    } else if (e instanceof Anthropic.PermissionDeniedError) msg = `permission denied: ${e.message}`;
    else if (e instanceof Anthropic.RateLimitError) msg = "rate limited";
    else if (e instanceof Anthropic.APIError) msg = `API error ${e.status}: ${e.message}`;
    else msg = e.message;
    lastCall = { ok: false, model, at: Date.now(), error: String(msg).slice(0, 200) };
    console.warn("[ai]", msg);
    return null;
  }
}
