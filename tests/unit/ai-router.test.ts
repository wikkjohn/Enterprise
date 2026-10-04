import { describe, expect, it } from "vitest";
import { estimateCostUsd, rankModels, type RoutableModel } from "../../packages/ai/src";

const m = (o: Partial<RoutableModel>): RoutableModel => ({
  providerId: "p", providerKey: "anthropic", providerKind: "anthropic", organizationId: null, modelKey: "x", capabilities: ["text"], tier: "standard",
  maxDataClassification: "confidential", inputCostPerMtok: 2, outputCostPerMtok: 10, contextWindow: 200_000, ...o,
});
const models = [
  m({ modelKey: "premium", tier: "premium", inputCostPerMtok: 4, outputCostPerMtok: 20, capabilities: ["text", "reasoning"] }),
  m({ modelKey: "standard", tier: "standard" }),
  m({ modelKey: "economy", tier: "economy", inputCostPerMtok: 1, outputCostPerMtok: 5, maxDataClassification: "internal" }),
  m({ modelKey: "byo", tier: "standard", organizationId: "org-1", inputCostPerMtok: 3, outputCostPerMtok: 12 }),
];

describe("model routing", () => {
  it("excludes models not approved for the data classification, with reasons", () => {
    const r = rankModels(models, { dataClassification: "confidential" });
    expect(r.ranked.map((x) => x.modelKey)).not.toContain("economy");
    expect(r.excluded).toContainEqual({ model: "anthropic/economy", reason: "not approved for confidential data" });
  });
  it("prefers the requested tier, then tenant-owned, then cheapest", () => {
    expect(rankModels(models, { dataClassification: "internal", tier: "economy" }).ranked[0]!.modelKey).toBe("economy");
    expect(rankModels(models, { dataClassification: "internal", tier: "standard" }).ranked[0]!.modelKey).toBe("byo");
    expect(rankModels(models, { dataClassification: "internal", capabilities: ["reasoning"] }).ranked.map((x) => x.modelKey)).toEqual(["premium"]);
  });
  it("respects explicit model and context window", () => {
    expect(rankModels(models, { dataClassification: "internal", model: "standard" }).ranked.map((x) => x.modelKey)).toEqual(["standard"]);
    expect(rankModels(models, { dataClassification: "internal", estimatedInputTokens: 500_000 }).ranked).toHaveLength(0);
  });
  it("estimates cost from per-MTok prices", () => {
    expect(estimateCostUsd({ inputCostPerMtok: 4, outputCostPerMtok: 20 }, 1_000_000, 500_000)).toBe(14);
    expect(estimateCostUsd({ inputCostPerMtok: 1, outputCostPerMtok: 5 }, 1234, 56)).toBeCloseTo(0.001514, 6);
  });
});
