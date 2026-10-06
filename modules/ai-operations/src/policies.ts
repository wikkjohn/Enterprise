/**
 * Business model-selection policies ("which model may/should this task use").
 *
 * AI Operations owns the policy and the reporting; the shared AI provider
 * layer performs execution. An `enforced` policy is applied through the AI
 * layer's routing-policy hook (filter + reorder candidates, fail closed when
 * nothing qualifies). An `advisory` policy never changes routing — it is only
 * used to report compliance and potential savings.
 */

export const MODEL_TIERS = ["economy", "standard", "premium"] as const;
export type Tier = (typeof MODEL_TIERS)[number];
export const CLASSIFICATIONS = ["public", "internal", "confidential", "restricted"] as const;

export interface ModelPolicyRules {
  /** Allowed quality tiers; empty = any. */
  allowedTiers: Tier[];
  /** Preferred tier: candidates are ordered nearest-first (then cheapest). */
  preferredTier: Tier | null;
  /** "provider/model" or "model"; empty = any. */
  allowedModels: string[];
  blockedModels: string[];
  /** Provider keys; regulatory/residency constraints are expressed here. Empty = any. */
  allowedProviders: string[];
  requiredCapabilities: string[];
  /** Combined input + output list price per million tokens. */
  maxCostPerMtok: number | null;
  /** Observed median latency ceiling (last 7 days). */
  maxLatencyMs: number | null;
}

export interface ModelPolicyMatch {
  /** Use-case patterns; `*` is a wildcard ("knowledge.*", "*.classify"). Empty = any. */
  useCases: string[];
  modules: string[];
  dataClassifications: string[];
}

export interface ModelPolicy {
  id: string;
  name: string;
  priority: number;
  enforcement: "advisory" | "enforced";
  status: "active" | "disabled";
  match: ModelPolicyMatch;
  rules: ModelPolicyRules;
  regulatoryNote?: string | null;
}

export interface CandidateModel {
  providerKey: string;
  modelKey: string;
  tier: Tier;
  capabilities: string[];
  inputCostPerMtok: number;
  outputCostPerMtok: number;
}

export interface PolicyRequest { useCase: string; moduleId: string; dataClassification: string }

const glob = (pattern: string, value: string) => {
  const re = new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
  return re.test(value);
};

export function matches(p: ModelPolicy, req: PolicyRequest): boolean {
  if (p.status !== "active") return false;
  if (p.match.useCases.length && !p.match.useCases.some((u) => glob(u, req.useCase))) return false;
  if (p.match.modules.length && !p.match.modules.includes(req.moduleId)) return false;
  if (p.match.dataClassifications.length && !p.match.dataClassifications.includes(req.dataClassification)) return false;
  return true;
}

/** The single policy that governs a request: highest priority (lowest number), then the most specific, then name. */
export function selectPolicy(policies: ModelPolicy[], req: PolicyRequest): ModelPolicy | null {
  const spec = (p: ModelPolicy) => (p.match.useCases.length ? 4 : 0) + (p.match.modules.length ? 2 : 0) + (p.match.dataClassifications.length ? 1 : 0);
  return policies.filter((p) => matches(p, req)).sort((a, b) => a.priority - b.priority || spec(b) - spec(a) || a.name.localeCompare(b.name))[0] ?? null;
}

const modelMatches = (list: string[], c: Pick<CandidateModel, "providerKey" | "modelKey">) => list.some((m) => m === c.modelKey || m === `${c.providerKey}/${c.modelKey}`);
const TIER_RANK: Record<Tier, number> = { economy: 0, standard: 1, premium: 2 };

/** Why a candidate is not allowed by the rules, or null when it is. */
export function violation(rules: ModelPolicyRules, c: CandidateModel, latencyMs?: number | null): string | null {
  if (rules.allowedTiers.length && !rules.allowedTiers.includes(c.tier)) return `tier ${c.tier} not allowed`;
  if (rules.allowedModels.length && !modelMatches(rules.allowedModels, c)) return "model not on the allowed list";
  if (rules.blockedModels.length && modelMatches(rules.blockedModels, c)) return "model is blocked";
  if (rules.allowedProviders.length && !rules.allowedProviders.includes(c.providerKey)) return `provider ${c.providerKey} not allowed`;
  const missing = rules.requiredCapabilities.filter((x) => !c.capabilities.includes(x));
  if (missing.length) return `missing capabilities: ${missing.join(", ")}`;
  if (rules.maxCostPerMtok != null && c.inputCostPerMtok + c.outputCostPerMtok > rules.maxCostPerMtok) return "above the cost ceiling";
  if (rules.maxLatencyMs != null && latencyMs != null && latencyMs > rules.maxLatencyMs) return "observed latency above the ceiling";
  return null;
}

/** Filter + order candidates by a policy. Returns an empty list when nothing qualifies (callers fail closed). */
export function applyPolicy<C extends CandidateModel>(policy: ModelPolicy, candidates: C[], latency: (c: C) => number | null = () => null): { allowed: C[]; excluded: Array<{ model: string; reason: string }> } {
  const excluded: Array<{ model: string; reason: string }> = [];
  const allowed = candidates.filter((c) => {
    const why = violation(policy.rules, c, latency(c));
    if (why) excluded.push({ model: `${c.providerKey}/${c.modelKey}`, reason: `${policy.name}: ${why}` });
    return !why;
  });
  const want = policy.rules.preferredTier;
  if (want) {
    const dist = (c: C) => Math.abs(TIER_RANK[c.tier] - TIER_RANK[want]);
    // Stable sort keeps the AI layer's own order (organization models first, then cost) within equal distance.
    allowed.sort((a, b) => dist(a) - dist(b));
  }
  return { allowed, excluded };
}

export interface RunGroup extends PolicyRequest {
  provider: string;
  model: string;
  tier: Tier;
  capabilities: string[];
  inputCostPerMtok: number;
  outputCostPerMtok: number;
  runs: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  medianLatencyMs: number | null;
}

export interface PolicyCompliance {
  policyId: string;
  policyName: string;
  enforcement: ModelPolicy["enforcement"];
  runs: number;
  compliantRuns: number;
  nonCompliant: Array<{ useCase: string; moduleId: string; model: string; runs: number; cost: number; reason: string }>;
  /** Cost of non-compliant runs if they had used the cheapest allowed model seen. */
  potentialSavings: number;
}

/** How past AI runs line up with today's policies (reporting only). */
export function compliance(policies: ModelPolicy[], groups: RunGroup[], catalog: CandidateModel[]): PolicyCompliance[] {
  const out = new Map<string, PolicyCompliance>();
  for (const g of groups) {
    const p = selectPolicy(policies, g);
    if (!p) continue;
    const row = out.get(p.id) ?? { policyId: p.id, policyName: p.name, enforcement: p.enforcement, runs: 0, compliantRuns: 0, nonCompliant: [], potentialSavings: 0 };
    row.runs += g.runs;
    const why = violation(p.rules, { ...g, providerKey: g.provider, modelKey: g.model }, g.medianLatencyMs);
    if (!why) row.compliantRuns += g.runs;
    else {
      row.nonCompliant.push({ useCase: g.useCase, moduleId: g.moduleId, model: `${g.provider}/${g.model}`, runs: g.runs, cost: Math.round(g.cost * 100) / 100, reason: why });
      const cheapest = applyPolicy(p, catalog).allowed.map((c) => (g.inputTokens * c.inputCostPerMtok + g.outputTokens * c.outputCostPerMtok) / 1e6).sort((a, b) => a - b)[0];
      if (cheapest != null && cheapest < g.cost) row.potentialSavings += g.cost - cheapest;
    }
    out.set(p.id, row);
  }
  return [...out.values()].map((r) => ({ ...r, potentialSavings: Math.round(r.potentialSavings * 100) / 100 }));
}
