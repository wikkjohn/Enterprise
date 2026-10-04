import { assertSafeOutboundUrl } from "@eaop/security";
import { AppError } from "@eaop/shared-types";
import { type AIGenerateResponse, type AIProvider, type ProviderKind } from "../types";

/**
 * Chat Completions adapter for OpenAI and OpenAI-compatible endpoints
 * (Azure OpenAI deployments, vLLM, Ollama and other private model servers).
 * config: { baseUrl, apiVersion? (azure) }
 */
export function createOpenAICompatibleProvider(kind: Extract<ProviderKind, "openai" | "openai_compatible" | "azure_openai" | "local">, opts: { allowPrivateNetworks: boolean; fetchImpl?: typeof fetch }): AIProvider {
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    kind,
    async generate(req, runtime, signal): Promise<AIGenerateResponse> {
      const baseUrl = String(runtime.config.baseUrl ?? "").replace(/\/$/, "");
      if (!baseUrl) throw new AppError("NOT_CONFIGURED", `${kind} provider has no baseUrl.`);
      const isAzure = kind === "azure_openai";
      const url = isAzure
        ? `${baseUrl}/openai/deployments/${encodeURIComponent(req.model)}/chat/completions?api-version=${encodeURIComponent(String(runtime.config.apiVersion ?? "2024-10-21"))}`
        : `${baseUrl}/chat/completions`;
      // Private/local model servers legitimately live on private networks.
      await assertSafeOutboundUrl(url, { allowHttp: kind === "local", allowPrivateNetworks: opts.allowPrivateNetworks || kind === "local" });
      if (!runtime.apiKey && kind !== "local") throw new AppError("NOT_CONFIGURED", `${kind} API key is not configured.`);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (runtime.apiKey) {
        if (isAzure) headers["api-key"] = runtime.apiKey;
        else headers.authorization = `Bearer ${runtime.apiKey}`;
      }
      const body = {
        ...(isAzure ? {} : { model: req.model }),
        messages: [...(req.system ? [{ role: "system", content: req.system }] : []), ...req.messages],
        max_completion_tokens: req.maxTokens,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.responseFormat === "json" ? { response_format: { type: "json_object" } } : {}),
      };
      let res: Response;
      try {
        res = await doFetch(url, { method: "POST", headers, body: JSON.stringify(body), signal, redirect: "manual" });
      } catch (err) {
        if ((err as Error).name === "AbortError" || (err as Error).name === "TimeoutError") throw new AppError("UPSTREAM_TIMEOUT", "AI provider timed out.", undefined, { retryable: true });
        throw new AppError("UPSTREAM_ERROR", "AI provider unreachable.", undefined, { retryable: true });
      }
      if (res.status === 429) throw new AppError("RATE_LIMITED", "AI provider rate limit reached.", { provider: kind }, { retryable: true });
      if (res.status === 401 || res.status === 403) throw new AppError("NOT_CONFIGURED", "AI provider rejected the configured credentials.", { provider: kind });
      if (res.status >= 400) throw new AppError(res.status >= 500 ? "UPSTREAM_ERROR" : "VALIDATION_FAILED", `AI provider error (${res.status}).`, { provider: kind }, { retryable: res.status >= 500 });
      const json = (await res.json()) as {
        model?: string;
        choices?: Array<{ message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = json.choices?.[0];
      const refused = !!choice?.message?.refusal || choice?.finish_reason === "content_filter";
      return {
        text: refused ? "" : (choice?.message?.content ?? ""),
        servedModel: json.model ?? req.model,
        finishReason: refused ? "refusal" : choice?.finish_reason === "stop" ? "stop" : choice?.finish_reason === "length" ? "length" : "other",
        usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 },
        refusalCategory: refused ? null : undefined,
      };
    },
  };
}
