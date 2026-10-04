import { type PolicyEffect } from "@eaop/shared-types";

export type ProviderKind = "anthropic" | "openai" | "openai_compatible" | "azure_openai" | "google" | "bedrock" | "local" | "sandbox";
export type DataClassification = "public" | "internal" | "confidential" | "restricted";
export const CLASSIFICATION_RANK: Record<DataClassification, number> = { public: 0, internal: 1, confidential: 2, restricted: 3 };
export type ModelTier = "economy" | "standard" | "premium";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AIMessage {
  role: "user" | "assistant";
  content: string;
}

/** Provider-neutral request. Modules never see provider-specific shapes. */
export interface AIGenerateRequest {
  model: string;
  system?: string;
  messages: AIMessage[];
  maxTokens: number;
  /** Reasoning depth; providers that do not support it ignore it. */
  effort?: Effort;
  /** Ask for a JSON object response (best-effort per provider). */
  responseFormat?: "text" | "json";
  /** Only honoured by providers/models that still accept sampling parameters. */
  temperature?: number;
}

export interface AIGenerateResponse {
  text: string;
  /** Model that actually served the request (may differ after a provider-side fallback). */
  servedModel: string;
  finishReason: "stop" | "length" | "refusal" | "other";
  usage: { inputTokens: number; outputTokens: number };
  /** Provider refusal category, when finishReason = "refusal". */
  refusalCategory?: string | null;
}

export interface ProviderRuntimeConfig {
  apiKey?: string;
  config: Record<string, unknown>;
}

export interface AIProvider {
  kind: ProviderKind;
  generate(req: AIGenerateRequest, runtime: ProviderRuntimeConfig, signal: AbortSignal): Promise<AIGenerateResponse>;
}

export interface PromptTemplateRef {
  id: string;
  version: string;
}

/**
 * Pre-execution hook. Modules (e.g. AI Data Security DLP) register hooks that
 * may BLOCK, REDACT (by returning a modified request) or REQUIRE_APPROVAL.
 */
export interface AIPolicyHookResult {
  decision: PolicyEffect | "REDACT";
  reasons?: string[];
  request?: { system?: string; messages: AIMessage[] };
}
export type AIPolicyHook = (input: {
  organizationId: string;
  moduleId: string;
  useCase: string;
  dataClassification: DataClassification;
  model: { provider: string; model: string; tier: ModelTier };
  request: { system?: string; messages: AIMessage[] };
}) => Promise<AIPolicyHookResult>;
