// Thin wrapper around the Anthropic SDK. Every caller supplies a heuristic
// fallback, so a missing key, a refusal, or a network error never breaks the app.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { config } from "../config.js";

let client = null;
let disabledReason = config.aiDisabled ? "AXOL_DISABLE_AI=1" : null;

function getClient() {
  if (disabledReason) return null;
  if (!client) {
    try {
      // Resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile.
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
  return { enabled: !!c, model: config.model, reason: disabledReason };
}

/**
 * Ask Claude for a JSON object matching `schema` (a zod schema).
 * Returns the parsed object, or null when AI is unavailable / refused / failed.
 */
export async function structured({ schema, system, user, effort = "medium", maxTokens = 8000 }) {
  const c = getClient();
  if (!c) return null;
  try {
    const res = await c.beta.messages.parse({
      model: config.model,
      max_tokens: maxTokens,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
      output_config: { effort, format: zodOutputFormat(schema) },
      // Server-side safety fallback: if the primary model declines, the API re-runs
      // the request on a fallback model inside the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    if (res.stop_reason === "refusal") {
      console.warn("[ai] refusal", res.stop_details?.category, res.stop_details?.explanation);
      return null;
    }
    return res.parsed_output ?? null;
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) {
      disabledReason = "Invalid Anthropic credentials; running on heuristics";
      console.warn("[ai]", disabledReason);
    } else if (e instanceof Anthropic.RateLimitError) {
      console.warn("[ai] rate limited; using heuristics for this call");
    } else if (e instanceof Anthropic.APIError) {
      console.warn(`[ai] API error ${e.status}: ${e.message}`);
    } else {
      console.warn("[ai] error:", e.message);
    }
    return null;
  }
}
