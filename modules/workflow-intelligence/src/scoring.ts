import { type RoiResult, weakest } from "./roi";
import { type Provenance, type StepType } from "./schema";

/**
 * Transparent scoring model. 15 dimensions are rated 1–5 — nine are entered
 * by people (with provenance), six are derived from the workflow model with
 * published thresholds. Six outputs (0–100) are weighted averages of those
 * ratings; every output lists its components, weights, contributions and the
 * ratings that were defaulted. No number is produced without an explanation.
 */

export const SCORE_MODEL_VERSION = "wi-score-1.0";

export type DimensionKey =
  | "labor_intensity"
  | "volume"
  | "repetitiveness"
  | "decision_complexity"
  | "human_judgment"
  | "data_availability"
  | "data_quality"
  | "integration_availability"
  | "systems_count"
  | "handoffs"
  | "error_tolerance"
  | "security_sensitivity"
  | "regulatory_exposure"
  | "savings_potential"
  | "revenue_potential";

export interface DimensionDefinition {
  key: DimensionKey;
  label: string;
  kind: "rated" | "derived";
  /** What a 1 and a 5 mean. */
  scale: string;
}

export const DIMENSIONS: DimensionDefinition[] = [
  { key: "labor_intensity", label: "Labor intensity", kind: "derived", scale: "Annual human hours: <100 → 1, <500 → 2, <2,000 → 3, <8,000 → 4, ≥8,000 → 5" },
  { key: "volume", label: "Volume", kind: "derived", scale: "Executions/year: <100 → 1, <1,000 → 2, <10,000 → 3, <100,000 → 4, ≥100,000 → 5" },
  { key: "repetitiveness", label: "Repetitiveness", kind: "rated", scale: "1 = every case is different · 5 = identical, repeatable steps" },
  { key: "decision_complexity", label: "Decision complexity", kind: "rated", scale: "1 = simple rules · 5 = many interacting, ambiguous criteria" },
  { key: "human_judgment", label: "Human judgment required", kind: "rated", scale: "1 = none · 5 = expert judgment on every case" },
  { key: "data_availability", label: "Data availability", kind: "rated", scale: "1 = data on paper / in heads · 5 = all inputs digital and accessible" },
  { key: "data_quality", label: "Data quality", kind: "rated", scale: "1 = incomplete, inconsistent · 5 = clean, validated, structured" },
  { key: "integration_availability", label: "Integration availability", kind: "rated", scale: "1 = no APIs · 5 = documented APIs / connectors for every system" },
  { key: "systems_count", label: "Systems involved", kind: "derived", scale: "Distinct systems: ≤1 → 1, 2 → 2, 3 → 3, 4–5 → 4, ≥6 → 5" },
  { key: "handoffs", label: "Handoffs", kind: "derived", scale: "Role changes between consecutive steps: 0 → 1, 1–2 → 2, 3–4 → 3, 5–7 → 4, ≥8 → 5" },
  { key: "error_tolerance", label: "Error tolerance", kind: "rated", scale: "1 = any error is severe · 5 = errors are cheap and easily corrected" },
  { key: "security_sensitivity", label: "Security sensitivity", kind: "rated", scale: "1 = public data · 5 = highly confidential / restricted data" },
  { key: "regulatory_exposure", label: "Regulatory exposure", kind: "rated", scale: "1 = unregulated · 5 = heavily regulated, audited decisions" },
  { key: "savings_potential", label: "Savings potential", kind: "derived", scale: "Estimated annual savings: <$10k → 1, <$50k → 2, <$250k → 3, <$1M → 4, ≥$1M → 5" },
  { key: "revenue_potential", label: "Revenue potential", kind: "derived", scale: "Annual revenue uplift: $0 → 1, <$50k → 2, <$250k → 3, <$1M → 4, ≥$1M → 5" },
];

export const RATED_DIMENSIONS = DIMENSIONS.filter((d) => d.kind === "rated").map((d) => d.key);
export const DEFAULT_RATING = 3;

export interface Rating {
  value: number;
  provenance: Provenance;
  note?: string;
}

export interface DimensionValue {
  key: DimensionKey;
  label: string;
  rating: number;
  provenance: Provenance;
  defaulted: boolean;
  detail: string;
}

export type ScoreKey = "aiOpportunity" | "automationReadiness" | "dataReadiness" | "risk" | "integrationComplexity" | "expectedRoi";

export interface ScoreComponent {
  dimension: DimensionKey | "risk_category" | "roi_3yr" | "payback";
  label: string;
  rating: number | null;
  weight: number;
  inverse: boolean;
  /** Points this component adds to the 0–100 score. */
  contribution: number;
  provenance: Provenance;
  detail: string;
}

export interface Score {
  key: ScoreKey;
  label: string;
  value: number;
  band: "low" | "medium" | "high";
  /** For risk and integration complexity, high is bad. */
  higherIsBetter: boolean;
  provenance: Provenance;
  components: ScoreComponent[];
  defaultedDimensions: DimensionKey[];
  explanation: string;
}

export interface ScoringInput {
  annualVolume: number;
  riskCategory: "low" | "medium" | "high" | "critical";
  systems: string[];
  steps: Array<{ type: StepType; role: string | null; system: string | null; durationMinutes: number; frequencyPerRun: number; sort: number }>;
  ratings: Partial<Record<DimensionKey, Rating>>;
  roi: RoiResult;
}

export interface ScoringResult {
  modelVersion: string;
  dimensions: DimensionValue[];
  scores: Record<ScoreKey, Score>;
}

const band = (v: number): Score["band"] => (v >= 67 ? "high" : v >= 34 ? "medium" : "low");
const r1 = (n: number) => Math.round(n * 10) / 10;
const thresholds = (v: number, t: number[]) => 1 + t.filter((x) => v >= x).length;
const LABOR: StepType[] = ["human_task", "approval", "decision", "exception"];

export function deriveDimensions(input: ScoringInput): DimensionValue[] {
  const def = (k: DimensionKey) => DIMENSIONS.find((d) => d.key === k)!;
  const out: DimensionValue[] = [];
  const humanHours = input.roi.outputs.currentAnnualHours.value ?? 0;
  const ordered = [...input.steps].sort((a, b) => a.sort - b.sort);
  const systems = new Set([...input.systems, ...ordered.map((s) => s.system).filter((s): s is string => !!s)].map((s) => s.trim().toLowerCase()).filter(Boolean));
  let handoffs = 0;
  let prev: string | null = null;
  for (const s of ordered) {
    if (!s.role) continue;
    if (prev !== null && s.role !== prev) handoffs++;
    prev = s.role;
  }
  const savings = input.roi.outputs.annualSavings.value ?? 0;
  const revenue = input.roi.outputs.annualRevenue.value ?? 0;
  const hasLabor = ordered.some((s) => LABOR.includes(s.type));

  for (const d of DIMENSIONS) {
    switch (d.key) {
      case "labor_intensity":
        out.push({ key: d.key, label: d.label, rating: thresholds(humanHours, [100, 500, 2000, 8000]), provenance: "fact", defaulted: false, detail: hasLabor ? `${Math.round(humanHours).toLocaleString("en-US")} human hours/year from the step model` : "No human steps modeled — rated 1" });
        break;
      case "volume":
        out.push({ key: d.key, label: d.label, rating: thresholds(input.annualVolume, [100, 1000, 10000, 100000]), provenance: "fact", defaulted: false, detail: `${input.annualVolume.toLocaleString("en-US")} executions/year` });
        break;
      case "systems_count":
        out.push({ key: d.key, label: d.label, rating: thresholds(systems.size, [2, 3, 4, 6]), provenance: "fact", defaulted: false, detail: `${systems.size} distinct system(s)${systems.size ? `: ${[...systems].slice(0, 6).join(", ")}` : ""}` });
        break;
      case "handoffs":
        out.push({ key: d.key, label: d.label, rating: thresholds(handoffs, [1, 3, 5, 8]), provenance: "fact", defaulted: false, detail: `${handoffs} role handoff(s) between consecutive steps` });
        break;
      case "savings_potential":
        out.push({ key: d.key, label: d.label, rating: thresholds(savings, [10_000, 50_000, 250_000, 1_000_000]), provenance: input.roi.outputs.annualSavings.provenance, defaulted: false, detail: `$${Math.round(savings).toLocaleString("en-US")}/year from the ROI model` });
        break;
      case "revenue_potential":
        out.push({ key: d.key, label: d.label, rating: revenue <= 0 ? 1 : thresholds(revenue, [0.01, 50_000, 250_000, 1_000_000]), provenance: input.roi.outputs.annualRevenue.provenance, defaulted: false, detail: `$${Math.round(revenue).toLocaleString("en-US")}/year revenue uplift assumption` });
        break;
      default: {
        const r = input.ratings[d.key];
        if (r) out.push({ key: d.key, label: d.label, rating: Math.min(5, Math.max(1, Math.round(r.value))), provenance: r.provenance, defaulted: false, detail: r.note ? r.note : `Rated ${r.value}/5` });
        else out.push({ key: d.key, label: d.label, rating: DEFAULT_RATING, provenance: "assumption", defaulted: true, detail: `Not rated — neutral default ${DEFAULT_RATING}/5 assumed (${def(d.key).scale})` });
      }
    }
  }
  return out;
}

const RISK_CATEGORY_RATING = { low: 1, medium: 3, high: 4, critical: 5 } as const;

interface WeightSpec {
  dimension: DimensionKey;
  weight: number;
  inverse?: boolean;
}

function weighted(key: ScoreKey, label: string, higherIsBetter: boolean, specs: WeightSpec[], dims: Map<DimensionKey, DimensionValue>, extra: ScoreComponent[] = []): Score {
  const components: ScoreComponent[] = specs.map((s) => {
    const d = dims.get(s.dimension)!;
    const normalized = ((s.inverse ? 6 - d.rating : d.rating) - 1) / 4; // 0..1
    return {
      dimension: s.dimension,
      label: d.label,
      rating: d.rating,
      weight: s.weight,
      inverse: !!s.inverse,
      contribution: r1(normalized * s.weight * 100),
      provenance: d.provenance,
      detail: `${d.detail}${s.inverse ? " (inverted: higher rating lowers this score)" : ""}`,
    };
  });
  const all = [...components, ...extra];
  const value = r1(all.reduce((n, c) => n + c.contribution, 0));
  const defaulted = specs.map((s) => dims.get(s.dimension)!).filter((d) => d.defaulted).map((d) => d.key);
  const top = [...all].sort((a, b) => b.contribution - a.contribution).slice(0, 2).map((c) => `${c.label} (${c.contribution} pts)`);
  return {
    key, label, value, band: band(value), higherIsBetter,
    provenance: weakest(...all.map((c) => c.provenance)),
    components: all,
    defaultedDimensions: defaulted,
    explanation:
      `${label} = Σ weight × normalized rating (1→0, 5→1) × 100. ` +
      `Weights: ${all.map((c) => `${c.label}${c.inverse ? " (inverse)" : ""} ${Math.round(c.weight * 100)}%`).join(", ")}. ` +
      `Largest contributors: ${top.join(", ")}.` +
      (defaulted.length ? ` ${defaulted.length} rating(s) not provided and assumed neutral: ${defaulted.join(", ")}.` : ""),
  };
}

export function scoreWorkflow(input: ScoringInput): ScoringResult {
  const dimensions = deriveDimensions(input);
  const dims = new Map(dimensions.map((d) => [d.key, d]));

  const riskCategory: ScoreComponent = {
    dimension: "risk_category",
    label: "Workflow risk category",
    rating: RISK_CATEGORY_RATING[input.riskCategory],
    weight: 0.2,
    inverse: false,
    contribution: r1(((RISK_CATEGORY_RATING[input.riskCategory] - 1) / 4) * 0.2 * 100),
    provenance: "fact",
    detail: `Risk category "${input.riskCategory}" → ${RISK_CATEGORY_RATING[input.riskCategory]}/5`,
  };

  const roi3 = input.roi.outputs.roi3yrPct;
  const payback = input.roi.outputs.paybackMonths;
  const roiNorm = roi3.value == null ? 0 : Math.min(1, Math.max(0, roi3.value / 300));
  const pb = payback.value;
  const pbNorm = pb == null ? 0 : pb <= 6 ? 1 : pb <= 12 ? 0.8 : pb <= 24 ? 0.5 : pb <= 36 ? 0.25 : 0;
  const expectedRoiComponents: ScoreComponent[] = [
    { dimension: "roi_3yr", label: "3-year ROI", rating: null, weight: 0.6, inverse: false, contribution: r1(roiNorm * 60), provenance: roi3.provenance, detail: roi3.value == null ? `3-year ROI undefined (${roi3.note ?? "missing inputs"}) → 0` : `${roi3.value}% (300% or more = full marks)` },
    { dimension: "payback", label: "Payback period", rating: null, weight: 0.4, inverse: false, contribution: r1(pbNorm * 40), provenance: payback.provenance, detail: pb == null ? `No payback (${payback.note ?? "missing inputs"}) → 0` : `${pb} months (≤6 → 100%, ≤12 → 80%, ≤24 → 50%, ≤36 → 25%, longer → 0)` },
  ];
  const expectedRoiValue = r1(expectedRoiComponents.reduce((n, c) => n + c.contribution, 0));

  const scores: Record<ScoreKey, Score> = {
    aiOpportunity: weighted("aiOpportunity", "AI Opportunity", true, [
      { dimension: "labor_intensity", weight: 0.25 },
      { dimension: "volume", weight: 0.15 },
      { dimension: "repetitiveness", weight: 0.15 },
      { dimension: "savings_potential", weight: 0.2 },
      { dimension: "revenue_potential", weight: 0.1 },
      { dimension: "human_judgment", weight: 0.15, inverse: true },
    ], dims),
    automationReadiness: weighted("automationReadiness", "Automation Readiness", true, [
      { dimension: "repetitiveness", weight: 0.3 },
      { dimension: "integration_availability", weight: 0.25 },
      { dimension: "decision_complexity", weight: 0.25, inverse: true },
      { dimension: "error_tolerance", weight: 0.2 },
    ], dims),
    dataReadiness: weighted("dataReadiness", "Data Readiness", true, [
      { dimension: "data_availability", weight: 0.5 },
      { dimension: "data_quality", weight: 0.5 },
    ], dims),
    risk: weighted("risk", "Risk", false, [
      { dimension: "security_sensitivity", weight: 0.35 },
      { dimension: "regulatory_exposure", weight: 0.35 },
      { dimension: "error_tolerance", weight: 0.1, inverse: true },
    ], dims, [riskCategory]),
    integrationComplexity: weighted("integrationComplexity", "Integration Complexity", false, [
      { dimension: "systems_count", weight: 0.4 },
      { dimension: "integration_availability", weight: 0.4, inverse: true },
      { dimension: "handoffs", weight: 0.2 },
    ], dims),
    expectedRoi: {
      key: "expectedRoi",
      label: "Expected ROI",
      value: expectedRoiValue,
      band: band(expectedRoiValue),
      higherIsBetter: true,
      provenance: weakest(...expectedRoiComponents.map((c) => c.provenance)),
      components: expectedRoiComponents,
      defaultedDimensions: [],
      explanation: `Expected ROI = 60% × min(3-year ROI ÷ 300%, 1) + 40% × payback factor. Inputs come from the ROI model (${input.roi.modelVersion}); see its assumptions for provenance.`,
    },
  };
  return { modelVersion: SCORE_MODEL_VERSION, dimensions, scores };
}

/** Portfolio placement: value vs. complexity (2×2). */
export type Quadrant = "quick_win" | "strategic_bet" | "fill_in" | "deprioritize";
export const QUADRANT_LABELS: Record<Quadrant, string> = {
  quick_win: "Quick win — high value, low complexity",
  strategic_bet: "Strategic bet — high value, high complexity",
  fill_in: "Fill-in — low value, low complexity",
  deprioritize: "Deprioritize — low value, high complexity",
};

export function portfolioPosition(scores: Record<ScoreKey, Score>) {
  const value = r1(scores.aiOpportunity.value * 0.6 + scores.expectedRoi.value * 0.4);
  const complexity = r1(scores.integrationComplexity.value * 0.5 + (100 - scores.automationReadiness.value) * 0.3 + (100 - scores.dataReadiness.value) * 0.2);
  const quadrant: Quadrant = value >= 50 ? (complexity < 50 ? "quick_win" : "strategic_bet") : complexity < 50 ? "fill_in" : "deprioritize";
  return {
    value,
    complexity,
    risk: scores.risk.value,
    quadrant,
    explanation: `Value = 60% AI Opportunity + 40% Expected ROI = ${value}. Complexity = 50% Integration Complexity + 30% (100 − Automation Readiness) + 20% (100 − Data Readiness) = ${complexity}. Threshold 50 on both axes → ${QUADRANT_LABELS[quadrant]}.`,
  };
}

/** "AI-ready": readiness and data readiness both at least medium-high and risk not high. */
export function isAiReady(scores: Record<ScoreKey, Score>) {
  return scores.automationReadiness.value >= 60 && scores.dataReadiness.value >= 60 && scores.risk.value < 67;
}
