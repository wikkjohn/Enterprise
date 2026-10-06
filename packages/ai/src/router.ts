import { CLASSIFICATION_RANK, type DataClassification, type ModelTier } from "./types";

export interface RoutableModel {
  providerId: string;
  providerKey: string;
  providerKind: string;
  organizationId: string | null;
  modelKey: string;
  capabilities: string[];
  tier: ModelTier;
  maxDataClassification: DataClassification;
  inputCostPerMtok: number;
  outputCostPerMtok: number;
  contextWindow: number | null;
}

export interface RoutingRequirements {
  /** Exact model to use; must still satisfy classification and availability. */
  model?: string;
  provider?: string;
  capabilities?: string[];
  tier?: ModelTier;
  dataClassification: DataClassification;
  estimatedInputTokens?: number;
}

/** Extension point (AI Operations Management): org routing policies by task, cost, privacy. */
export type RoutingPolicy = (candidates: RoutableModel[], req: RoutingRequirements & { organizationId: string; moduleId: string; useCase: string }) => RoutableModel[] | Promise<RoutableModel[]>;

const TIER_RANK: Record<ModelTier, number> = { economy: 0, standard: 1, premium: 2 };

/**
 * Deterministic model selection:
 *  1. filter: enabled, classification-approved, capabilities, context window
 *  2. apply registered routing policies (may filter/reorder)
 *  3. prefer the requested tier (or nearest above), tenant-owned models first,
 *     then lowest blended cost.
 * Returns ranked candidates with the reasons the others were excluded.
 */
export function rankModels(models: RoutableModel[], req: RoutingRequirements): { ranked: RoutableModel[]; excluded: Array<{ model: string; reason: string }> } {
  const excluded: Array<{ model: string; reason: string }> = [];
  const ok = models.filter((m) => {
    const id = `${m.providerKey}/${m.modelKey}`;
    if (req.model && m.modelKey !== req.model) return false;
    if (req.provider && m.providerKey !== req.provider) return false;
    if (CLASSIFICATION_RANK[m.maxDataClassification] < CLASSIFICATION_RANK[req.dataClassification]) {
      excluded.push({ model: id, reason: `not approved for ${req.dataClassification} data` });
      return false;
    }
    const missing = (req.capabilities ?? []).filter((c) => !m.capabilities.includes(c));
    if (missing.length) {
      excluded.push({ model: id, reason: `missing capabilities: ${missing.join(", ")}` });
      return false;
    }
    if (req.estimatedInputTokens && m.contextWindow && req.estimatedInputTokens > m.contextWindow) {
      excluded.push({ model: id, reason: "context window too small" });
      return false;
    }
    return true;
  });
  const want = req.tier ? TIER_RANK[req.tier] : undefined;
  const score = (m: RoutableModel) => {
    const tierDistance = want === undefined ? 0 : TIER_RANK[m.tier] >= want ? TIER_RANK[m.tier] - want : 10 + (want - TIER_RANK[m.tier]);
    return [tierDistance, m.organizationId ? 0 : 1, m.inputCostPerMtok + m.outputCostPerMtok];
  };
  const ranked = ok.sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < sa.length; i++) if (sa[i]! !== sb[i]!) return sa[i]! - sb[i]!;
    return a.modelKey.localeCompare(b.modelKey);
  });
  return { ranked, excluded };
}

export function estimateCostUsd(m: Pick<RoutableModel, "inputCostPerMtok" | "outputCostPerMtok">, inputTokens: number, outputTokens: number): number {
  return Math.round(((inputTokens * m.inputCostPerMtok + outputTokens * m.outputCostPerMtok) / 1_000_000) * 1e6) / 1e6;
}
