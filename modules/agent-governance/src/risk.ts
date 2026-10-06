import { type ActionType, type AutonomyLevel, type Environment, type Sensitivity } from "./schema";

/**
 * Explainable agent risk score (0–100). Nine factors are rated 1–5 from the
 * agent's configuration and history, each with a published rule; the score
 * is Σ weight × (rating − 1) / 4 × 100. Every component is returned with its
 * rating, weight, points and the evidence it was derived from.
 */
export const RISK_MODEL_VERSION = "ag-risk-1.0";

export interface RiskInput {
  environment: Environment;
  autonomyLevel: AutonomyLevel;
  connectedSystems: string[];
  customerImpact: number | null;
  regulatoryImpact: number | null;
  bindings: Array<{ actionType: ActionType; system: string; maxDataSensitivity: Sensitivity; financialLimit: number | null; environment: string; status: string }>;
  /** DENY decisions in the last 90 days. */
  recentViolations: number;
}

export interface RiskComponent {
  factor: string;
  label: string;
  rating: number;
  weight: number;
  points: number;
  assumed: boolean;
  evidence: string;
}

export interface RiskResult {
  modelVersion: string;
  score: number;
  band: "low" | "medium" | "high" | "critical";
  components: RiskComponent[];
  explanation: string;
}

const WEIGHTS = {
  sensitive_data: 0.15,
  financial_authority: 0.15,
  external_communication: 0.1,
  production_access: 0.1,
  autonomy: 0.15,
  connected_systems: 0.1,
  customer_impact: 0.1,
  regulatory_impact: 0.1,
  policy_violations: 0.05,
} as const;

const thresholds = (v: number, t: number[]) => 1 + t.filter((x) => v >= x).length;
const SENS: Record<Sensitivity, number> = { public: 1, internal: 2, confidential: 4, restricted: 5 };
const AUTONOMY: Record<AutonomyLevel, number> = { assistive: 1, supervised: 2, semi_autonomous: 4, autonomous: 5 };
const ENV: Record<Environment, number> = { development: 1, staging: 2, production: 5 };

export function scoreAgent(input: RiskInput): RiskResult {
  const active = input.bindings.filter((b) => b.status === "active");
  const maxSens = active.reduce<Sensitivity | null>((m, b) => (!m || SENS[b.maxDataSensitivity] > SENS[m] ? b.maxDataSensitivity : m), null);
  const limits = active.map((b) => b.financialLimit).filter((x): x is number => x !== null);
  const maxLimit = limits.length ? Math.max(...limits) : null;
  const sends = active.filter((b) => b.actionType === "SEND");
  const systems = new Set([...input.connectedSystems, ...active.map((b) => b.system).filter((s) => s !== "*")].map((s) => s.toLowerCase()));
  const wildcard = active.some((b) => b.system === "*");

  const c = (factor: keyof typeof WEIGHTS, label: string, rating: number, evidence: string, assumed = false): RiskComponent => ({
    factor, label, rating, weight: WEIGHTS[factor], points: Math.round(((rating - 1) / 4) * WEIGHTS[factor] * 1000) / 10, assumed, evidence,
  });
  const components: RiskComponent[] = [
    c("sensitive_data", "Sensitive data access", maxSens ? SENS[maxSens] : 1, maxSens ? `Highest data sensitivity granted: ${maxSens}` : "No active bindings"),
    c("financial_authority", "Financial authority", maxLimit === null ? 1 : thresholds(maxLimit, [1, 1_000, 10_000, 100_000]), maxLimit === null ? "No binding carries a financial limit" : `Largest financial limit: ${maxLimit.toLocaleString("en-US")}`),
    c("external_communication", "External communication", sends.length === 0 ? 1 : input.environment === "production" ? 5 : 4, sends.length ? `${sends.length} SEND binding(s)` : "No SEND bindings"),
    c("production_access", "Production access", ENV[input.environment], `Runs in ${input.environment}`),
    c("autonomy", "Autonomy", AUTONOMY[input.autonomyLevel], `Autonomy level: ${input.autonomyLevel.replace("_", " ")}`),
    c("connected_systems", "Connected systems", wildcard ? 5 : thresholds(systems.size, [2, 3, 4, 6]), wildcard ? "A binding applies to any system (*)" : `${systems.size} system(s): ${[...systems].slice(0, 6).join(", ") || "none"}`),
    c("customer_impact", "Customer impact", input.customerImpact ?? 3, input.customerImpact ? `Rated ${input.customerImpact}/5` : "Not rated — neutral 3 assumed", input.customerImpact === null),
    c("regulatory_impact", "Regulatory impact", input.regulatoryImpact ?? 3, input.regulatoryImpact ? `Rated ${input.regulatoryImpact}/5` : "Not rated — neutral 3 assumed", input.regulatoryImpact === null),
    c("policy_violations", "Historical policy violations", thresholds(input.recentViolations, [1, 3, 6, 11]), `${input.recentViolations} denied action(s) in the last 90 days`),
  ];
  const score = Math.round(components.reduce((n, x) => n + x.points, 0) * 10) / 10;
  const band = score >= 75 ? "critical" : score >= 55 ? "high" : score >= 30 ? "medium" : "low";
  const top = [...components].sort((a, b) => b.points - a.points).slice(0, 3).map((x) => `${x.label} (${x.points} pts)`);
  const assumed = components.filter((x) => x.assumed).map((x) => x.label);
  return {
    modelVersion: RISK_MODEL_VERSION,
    score,
    band,
    components,
    explanation: `Score = Σ weight × (rating − 1) ÷ 4 × 100 over nine factors. Largest contributors: ${top.join(", ")}. Bands: ≥75 critical, ≥55 high, ≥30 medium.${assumed.length ? ` Assumed (not rated): ${assumed.join(", ")}.` : ""}`,
  };
}

/** Days until the next attestation, by risk band. */
export const REVIEW_INTERVAL_DAYS: Record<RiskResult["band"], number> = { critical: 30, high: 90, medium: 180, low: 365 };
