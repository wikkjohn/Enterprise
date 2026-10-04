import Anthropic from "@anthropic-ai/sdk";
import { AppError } from "@eaop/shared-types";
import { type AIGenerateRequest, type AIGenerateResponse, type AIProvider, type ProviderRuntimeConfig } from "../types";

/** Models that accept `output_config.effort`. */
const EFFORT_MODELS = /^claude-(fable|mythos|opus|sonnet)-(5|4-[678])/;
/** Models for which server-side `fallbacks: "default"` is supported on the Claude API. */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
/** Claude Opus 5.5 defaults to "medium" effort; we always send an explicit value. */
const DEFAULT_EFFORT = "medium";

const clients = new Map<string, Anthropic>();
function clientFor(apiKey: string, baseURL?: string) {
  const k = `${baseURL ?? ""}|${apiKey}`;
  let c = clients.get(k);
  if (!c) {
    c = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}), maxRetries: 2, timeout: 10 * 60_000 });
    if (clients.size > 100) clients.clear();
    clients.set(k, c);
  }
  return c;
}

/**
 * Anthropic adapter (official SDK). Current models reject sampling
 * parameters and disabled thinking, so neither is ever sent: depth is
 * controlled with `effort`. A safety-classifier decline returns
 * stop_reason "refusal", surfaced as finishReason "refusal". Server-side
 * refusal fallback (`fallbacks: "default"`) is enabled unless the provider
 * config sets refusalFallback: "off"; `servedModel` reports which model
 * actually answered so cost is attributed correctly.
 */
export const anthropicProvider: AIProvider = {
  kind: "anthropic",
  async generate(req: AIGenerateRequest, runtime: ProviderRuntimeConfig, signal: AbortSignal): Promise<AIGenerateResponse> {
    if (!runtime.apiKey) throw new AppError("NOT_CONFIGURED", "Anthropic API key is not configured.");
    const client = clientFor(runtime.apiKey, runtime.config.baseUrl as string | undefined);
    const useFallback = runtime.config.refusalFallback !== "off" && FALLBACK_MODELS.has(req.model);
    const system = req.responseFormat === "json" ? `${req.system ?? ""}\n\nRespond with a single valid JSON object and nothing else.`.trim() : req.system;

    const params = {
      model: req.model,
      max_tokens: req.maxTokens,
      ...(system ? { system } : {}),
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      ...(EFFORT_MODELS.test(req.model) ? { output_config: { effort: req.effort ?? DEFAULT_EFFORT } } : {}),
      ...(useFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
    };

    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await client.beta.messages.create(params as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming, { signal });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) throw new AppError("RATE_LIMITED", "AI provider rate limit reached.", { provider: "anthropic" }, { retryable: true });
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) throw new AppError("NOT_CONFIGURED", "AI provider rejected the configured credentials.", { provider: "anthropic" });
      if (err instanceof Anthropic.BadRequestError) throw new AppError("VALIDATION_FAILED", "AI provider rejected the request.", { provider: "anthropic", reason: err.message.slice(0, 300) });
      if (err instanceof Anthropic.APIConnectionTimeoutError) throw new AppError("UPSTREAM_TIMEOUT", "AI provider timed out.", { provider: "anthropic" }, { retryable: true });
      if (err instanceof Anthropic.APIError) throw new AppError("UPSTREAM_ERROR", `AI provider error${err.status ? ` (${err.status})` : ""}.`, { provider: "anthropic" }, { retryable: (err.status ?? 500) >= 500 });
      throw err;
    }

    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const stop = response.stop_reason;
    const details = (response as unknown as { stop_details?: { category?: string | null } | null }).stop_details;
    return {
      text: stop === "refusal" ? "" : text,
      servedModel: response.model,
      finishReason: stop === "end_turn" || stop === "stop_sequence" ? "stop" : stop === "max_tokens" ? "length" : stop === "refusal" ? "refusal" : "other",
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      refusalCategory: stop === "refusal" ? (details?.category ?? null) : undefined,
    };
  },
};
