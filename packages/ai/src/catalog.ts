import { type DataClassification, type ModelTier, type ProviderKind } from "./types";

/**
 * Platform-provided provider/model catalog seeded into ai_providers/ai_models
 * (organization_id NULL). Prices are USD per 1M tokens, list prices as of
 * 2026-09 — treat as estimates and override per your contract.
 * Tenants can add their own providers/models (BYO key / deployment).
 */
export interface CatalogModel {
  modelKey: string;
  displayName: string;
  capabilities: string[];
  contextWindow: number;
  maxOutputTokens: number;
  inputCostPerMtok: number;
  outputCostPerMtok: number;
  tier: ModelTier;
  maxDataClassification: DataClassification;
}

export interface CatalogProvider {
  key: string;
  name: string;
  kind: ProviderKind;
  /** Env var holding the platform credential; provider stays not_configured without it. */
  credentialEnv?: string;
  config: Record<string, unknown>;
  models: CatalogModel[];
  developmentOnly?: boolean;
}

export const PLATFORM_AI_CATALOG: CatalogProvider[] = [
  {
    key: "anthropic",
    name: "Anthropic",
    kind: "anthropic",
    credentialEnv: "ANTHROPIC_API_KEY",
    config: { refusalFallback: "default" },
    models: [
      { modelKey: "claude-opus-5-5", displayName: "Claude Opus 5.5", capabilities: ["text", "reasoning", "json", "long_context", "vision", "tools"], contextWindow: 1_000_000, maxOutputTokens: 128_000, inputCostPerMtok: 4, outputCostPerMtok: 20, tier: "premium", maxDataClassification: "confidential" },
      { modelKey: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5", capabilities: ["text", "reasoning", "json", "long_context", "vision", "tools"], contextWindow: 1_000_000, maxOutputTokens: 128_000, inputCostPerMtok: 2, outputCostPerMtok: 10, tier: "standard", maxDataClassification: "confidential" },
      { modelKey: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", capabilities: ["text", "json", "vision", "tools"], contextWindow: 200_000, maxOutputTokens: 64_000, inputCostPerMtok: 1, outputCostPerMtok: 5, tier: "economy", maxDataClassification: "internal" },
    ],
  },
  {
    key: "openai",
    name: "OpenAI",
    kind: "openai",
    credentialEnv: "OPENAI_API_KEY",
    config: { baseUrl: "https://api.openai.com/v1" },
    // No models are pre-seeded: add the models your contract covers, with your prices.
    models: [],
  },
  {
    key: "sandbox",
    name: "Sandbox (simulated)",
    kind: "sandbox",
    config: {},
    developmentOnly: true,
    models: [
      { modelKey: "sandbox-echo", displayName: "Sandbox Echo (simulated, not a real model)", capabilities: ["text", "json"], contextWindow: 100_000, maxOutputTokens: 4_000, inputCostPerMtok: 0, outputCostPerMtok: 0, tier: "economy", maxDataClassification: "restricted" },
    ],
  },
];

/** Adapters planned but not shipped: configuration is accepted, execution fails NOT_IMPLEMENTED. */
export const UNIMPLEMENTED_PROVIDER_KINDS: ProviderKind[] = ["google", "bedrock"];
