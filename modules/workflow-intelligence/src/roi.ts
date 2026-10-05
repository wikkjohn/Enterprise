import { type Provenance, type StepType } from "./schema";

/**
 * Transparent ROI engine. Pure functions — no I/O. Every input carries a
 * provenance tag (FACT / ASSUMPTION / AI ESTIMATE) and every output carries
 * the formula that produced it and the weakest provenance of its inputs, so
 * a reader can always see what a number rests on.
 */

export const ROI_MODEL_VERSION = "wi-roi-1.0";

export interface TaggedValue {
  value: number;
  provenance: Provenance;
  rationale?: string;
}

export interface RoiStepInput {
  key: string;
  name: string;
  type: StepType;
  durationMinutes: number;
  frequencyPerRun: number;
  costPerExecution: number;
  errorRate: number;
  reworkRate: number;
  automationPotential: "unknown" | "none" | "low" | "medium" | "high";
  requiresApproval: boolean;
}

export interface RoiCostInput {
  category: string;
  period: "one_time" | "annual" | "per_execution";
  amount: number;
  provenance: Provenance;
  description?: string;
}

export interface RoiInput {
  annualVolume: number;
  steps: RoiStepInput[];
  costs: RoiCostInput[];
  /** Editable assumptions by key; missing keys fall back to DEFAULT_ASSUMPTIONS. */
  assumptions: Record<string, TaggedValue>;
}

export interface AssumptionDefinition {
  key: string;
  label: string;
  unit: "usd" | "usd_per_hour" | "ratio" | "usd_per_year";
  default: number;
  min: number;
  max: number;
  description: string;
}

export const ASSUMPTION_DEFINITIONS: AssumptionDefinition[] = [
  { key: "loaded_hourly_rate", label: "Loaded labor rate", unit: "usd_per_hour", default: 60, min: 0, max: 2000, description: "Fully loaded cost of one hour of employee time (salary, benefits, overhead)." },
  { key: "default_time_reduction", label: "Default time reduction", unit: "ratio", default: 0.4, min: 0, max: 1, description: "Share of a human step's time removed by AI/automation when the step's automation potential is unknown." },
  { key: "approval_time_reduction", label: "Approval prep time reduction", unit: "ratio", default: 0.25, min: 0, max: 0.6, description: "Share of approval time saved by AI-prepared context. Approvals stay human — capped at 60%." },
  { key: "error_reduction", label: "Error & rework reduction", unit: "ratio", default: 0.5, min: 0, max: 1, description: "Share of error/rework effort removed in the future state." },
  { key: "adoption_rate", label: "Adoption rate", unit: "ratio", default: 0.85, min: 0, max: 1, description: "Share of executions that actually run through the redesigned process." },
  { key: "ai_cost_per_execution", label: "AI inference cost / execution", unit: "usd", default: 0.05, min: 0, max: 100, description: "Model inference cost per workflow execution in the future state." },
  { key: "annual_revenue_uplift", label: "Annual revenue uplift", unit: "usd_per_year", default: 0, min: 0, max: 1e10, description: "Additional revenue per year attributable to the redesign (faster cycle, more capacity, new offers)." },
];

const POTENTIAL_REDUCTION: Record<string, number | null> = { none: 0, low: 0.2, medium: 0.5, high: 0.8, unknown: null };
/** Step types whose duration is employee time (as opposed to machine/wait time). */
export const LABOR_STEP_TYPES: StepType[] = ["human_task", "approval", "decision", "exception"];

const RANK: Record<Provenance, number> = { fact: 0, assumption: 1, ai_estimate: 2 };
/** The weakest provenance wins: one AI estimate makes the whole output an AI estimate. */
export function weakest(...p: Provenance[]): Provenance {
  return p.reduce<Provenance>((a, b) => (RANK[b] > RANK[a] ? b : a), "fact");
}

export interface RoiOutput {
  key: string;
  label: string;
  value: number | null;
  unit: "usd" | "hours" | "months" | "pct" | "usd_per_year";
  formula: string;
  provenance: Provenance;
  note?: string;
}

export interface RoiResult {
  modelVersion: string;
  inputs: Array<{ key: string; label: string; value: number; provenance: Provenance; defaulted: boolean; rationale?: string }>;
  outputs: Record<RoiOutputKey, RoiOutput>;
  stepBreakdown: Array<{ key: string; name: string; currentHours: number; futureHours: number; reduction: number; reductionSource: string }>;
  warnings: string[];
}

export type RoiOutputKey =
  | "currentAnnualHours"
  | "futureAnnualHours"
  | "laborHoursRecoverable"
  | "currentAnnualCost"
  | "futureAnnualCost"
  | "annualSavings"
  | "annualRevenue"
  | "implementationCost"
  | "recurringAnnualCost"
  | "netAnnualBenefit"
  | "paybackMonths"
  | "roi1yrPct"
  | "roi3yrPct"
  | "roi5yrPct";

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export function resolveAssumptions(given: Record<string, TaggedValue>) {
  const out: Record<string, TaggedValue & { defaulted: boolean }> = {};
  for (const def of ASSUMPTION_DEFINITIONS) {
    const g = given[def.key];
    out[def.key] = g
      ? { ...g, value: Math.min(def.max, Math.max(def.min, g.value)), defaulted: false }
      : { value: def.default, provenance: "assumption", rationale: "Platform default — edit to match your organization.", defaulted: true };
  }
  return out;
}

export function calculateRoi(input: RoiInput): RoiResult {
  const a = resolveAssumptions(input.assumptions);
  const warnings: string[] = [];
  const volume = Math.max(0, input.annualVolume);
  const rate = a.loaded_hourly_rate!.value;
  const adoption = a.adoption_rate!.value;
  if (volume === 0) warnings.push("Annual volume is 0 — every volume-driven figure is 0. Enter the workflow's yearly execution count.");
  if (input.steps.length === 0) warnings.push("The workflow has no steps — labor cost cannot be estimated. Model the steps first.");

  // ── Labor (per step) ─────────────────────────────────────────────────────
  let currentHours = 0;
  let futureHours = 0;
  let currentReworkHours = 0;
  let futureReworkHours = 0;
  let directCost = 0;
  const stepBreakdown: RoiResult["stepBreakdown"] = [];
  const laborProvenance: Provenance[] = ["fact"];
  for (const s of input.steps) {
    directCost += s.costPerExecution * s.frequencyPerRun * volume;
    if (!LABOR_STEP_TYPES.includes(s.type)) continue;
    const hours = (s.durationMinutes * s.frequencyPerRun * volume) / 60;
    const rework = hours * Math.min(1, s.errorRate + s.reworkRate);
    let reduction: number;
    let source: string;
    if (s.type === "approval" || s.requiresApproval) {
      reduction = a.approval_time_reduction!.value;
      source = "approval_time_reduction (approval stays human)";
      laborProvenance.push(a.approval_time_reduction!.provenance);
    } else if (POTENTIAL_REDUCTION[s.automationPotential] != null) {
      reduction = POTENTIAL_REDUCTION[s.automationPotential]!;
      source = `automation potential "${s.automationPotential}" → ${reduction * 100}%`;
    } else {
      reduction = a.default_time_reduction!.value;
      source = "default_time_reduction (automation potential unknown)";
      laborProvenance.push(a.default_time_reduction!.provenance);
    }
    const effective = reduction * adoption;
    const fHours = hours * (1 - effective);
    currentHours += hours;
    futureHours += fHours;
    currentReworkHours += rework;
    futureReworkHours += rework * (1 - a.error_reduction!.value * adoption);
    stepBreakdown.push({ key: s.key, name: s.name, currentHours: round(hours), futureHours: round(fHours), reduction: round(effective, 4), reductionSource: source });
  }
  laborProvenance.push(a.loaded_hourly_rate!.provenance, a.adoption_rate!.provenance);
  const reworkProvenance = weakest(...laborProvenance, a.error_reduction!.provenance);

  // ── Costs ────────────────────────────────────────────────────────────────
  const oneTime = input.costs.filter((c) => c.period === "one_time");
  const annual = input.costs.filter((c) => c.period === "annual");
  const perExec = input.costs.filter((c) => c.period === "per_execution");
  const implementationCost = oneTime.reduce((n, c) => n + c.amount, 0);
  const aiInference = a.ai_cost_per_execution!.value * volume * adoption;
  const recurring = annual.reduce((n, c) => n + c.amount, 0) + perExec.reduce((n, c) => n + c.amount * volume, 0) + aiInference;
  const costProvenance = weakest(...input.costs.map((c) => c.provenance));
  const recurringProvenance = weakest(...annual.map((c) => c.provenance), ...perExec.map((c) => c.provenance), a.ai_cost_per_execution!.provenance);
  if (oneTime.length === 0) warnings.push("No one-time implementation cost recorded — ROI percentages and payback cannot be computed.");

  const currentLaborCost = (currentHours + currentReworkHours) * rate;
  const futureLaborCost = (futureHours + futureReworkHours) * rate;
  const currentAnnualCost = currentLaborCost + directCost;
  const futureAnnualCost = futureLaborCost + directCost + recurring;
  const annualSavings = currentLaborCost - futureLaborCost;
  const annualRevenue = a.annual_revenue_uplift!.value;
  const netAnnualBenefit = annualSavings + annualRevenue - recurring;

  const lp = weakest(...laborProvenance);
  const savingsP = weakest(lp, reworkProvenance);
  const netP = weakest(savingsP, recurringProvenance, a.annual_revenue_uplift!.provenance);
  const roiP = weakest(netP, costProvenance);

  const roi = (years: number): RoiOutput => ({
    key: `roi${years}yrPct`,
    label: `ROI (${years} year${years > 1 ? "s" : ""})`,
    value: implementationCost > 0 ? round(((netAnnualBenefit * years - implementationCost) / implementationCost) * 100, 1) : null,
    unit: "pct",
    formula: `(net annual benefit × ${years} − implementation cost) ÷ implementation cost × 100`,
    provenance: roiP,
    ...(implementationCost > 0 ? {} : { note: "Undefined without an implementation cost." }),
  });

  const outputs: RoiResult["outputs"] = {
    currentAnnualHours: { key: "currentAnnualHours", label: "Current annual labor hours", value: round(currentHours + currentReworkHours), unit: "hours", formula: "Σ human steps (minutes × runs/execution × annual volume ÷ 60) × (1 + error rate + rework rate)", provenance: "fact" },
    futureAnnualHours: { key: "futureAnnualHours", label: "Future annual labor hours", value: round(futureHours + futureReworkHours), unit: "hours", formula: "Σ human steps current hours × (1 − step reduction × adoption) + rework hours × (1 − error reduction × adoption)", provenance: savingsP },
    laborHoursRecoverable: { key: "laborHoursRecoverable", label: "Recoverable labor hours / year", value: round(currentHours + currentReworkHours - futureHours - futureReworkHours), unit: "hours", formula: "current annual hours − future annual hours", provenance: savingsP },
    currentAnnualCost: { key: "currentAnnualCost", label: "Current annual cost", value: round(currentAnnualCost), unit: "usd_per_year", formula: "current labor hours × loaded rate + Σ step cost/execution × runs × volume", provenance: weakest("fact", a.loaded_hourly_rate!.provenance) },
    futureAnnualCost: { key: "futureAnnualCost", label: "Future annual cost", value: round(futureAnnualCost), unit: "usd_per_year", formula: "future labor hours × loaded rate + step direct costs + recurring costs (software, support, per-execution, AI inference)", provenance: weakest(savingsP, recurringProvenance) },
    annualSavings: { key: "annualSavings", label: "Estimated annual savings", value: round(annualSavings), unit: "usd_per_year", formula: "(current labor + rework hours − future labor + rework hours) × loaded rate", provenance: savingsP },
    annualRevenue: { key: "annualRevenue", label: "Potential annual revenue", value: round(annualRevenue), unit: "usd_per_year", formula: "annual_revenue_uplift assumption", provenance: a.annual_revenue_uplift!.provenance },
    implementationCost: { key: "implementationCost", label: "Implementation cost", value: round(implementationCost), unit: "usd", formula: "Σ one-time costs", provenance: weakest(...oneTime.map((c) => c.provenance)) },
    recurringAnnualCost: { key: "recurringAnnualCost", label: "Recurring annual cost", value: round(recurring), unit: "usd_per_year", formula: "Σ annual costs + Σ per-execution costs × volume + AI cost/execution × volume × adoption", provenance: recurringProvenance },
    netAnnualBenefit: { key: "netAnnualBenefit", label: "Net annual benefit", value: round(netAnnualBenefit), unit: "usd_per_year", formula: "annual savings + annual revenue − recurring annual cost", provenance: netP },
    paybackMonths: {
      key: "paybackMonths",
      label: "Payback period",
      value: implementationCost > 0 && netAnnualBenefit > 0 ? round(implementationCost / (netAnnualBenefit / 12), 1) : implementationCost === 0 && netAnnualBenefit > 0 ? 0 : null,
      unit: "months",
      formula: "implementation cost ÷ (net annual benefit ÷ 12)",
      provenance: roiP,
      ...(netAnnualBenefit <= 0 ? { note: "Never pays back: net annual benefit is not positive." } : {}),
    },
    roi1yrPct: roi(1),
    roi3yrPct: roi(3),
    roi5yrPct: roi(5),
  };
  if (netAnnualBenefit <= 0 && input.steps.length > 0 && volume > 0) warnings.push("Recurring costs exceed savings and revenue — this redesign does not create net value under the current assumptions.");

  return {
    modelVersion: ROI_MODEL_VERSION,
    inputs: [
      { key: "annual_volume", label: "Annual volume", value: volume, provenance: "fact", defaulted: false },
      ...ASSUMPTION_DEFINITIONS.map((d) => ({ key: d.key, label: d.label, value: a[d.key]!.value, provenance: a[d.key]!.provenance, defaulted: a[d.key]!.defaulted, rationale: a[d.key]!.rationale })),
      ...input.costs.map((c, i) => ({ key: `cost.${i}.${c.category}.${c.period}`, label: c.description || `${c.category} (${c.period.replace("_", " ")})`, value: c.amount, provenance: c.provenance, defaulted: false })),
    ],
    outputs,
    stepBreakdown,
    warnings,
  };
}

// ── Realized ROI ─────────────────────────────────────────────────────────

/**
 * Standard measurement keys. Baselines and measurements are recorded over a
 * period; everything is normalised to per-execution and annualised so the
 * comparison is like-for-like regardless of period length.
 */
export const MEASUREMENT_KEYS = ["executions", "labor_hours", "operating_cost", "cycle_time_minutes", "error_rate", "revenue"] as const;
export type MeasurementKey = (typeof MEASUREMENT_KEYS)[number];

export interface PeriodMetrics {
  periodDays: number;
  metrics: Partial<Record<MeasurementKey, number>>;
  provenance: Provenance;
}

export interface RealizedInput {
  baseline: PeriodMetrics;
  measurements: PeriodMetrics[];
  actualImplementationCost: number;
  projected: { annualSavings: number | null; laborHoursRecoverable: number | null; netAnnualBenefit: number | null; roi3yrPct: number | null; paybackMonths: number | null };
}

export interface VarianceLine {
  key: string;
  label: string;
  unit: RoiOutput["unit"];
  projected: number | null;
  actual: number | null;
  variance: number | null;
  variancePct: number | null;
  provenance: Provenance;
}

export interface RealizedResult {
  modelVersion: string;
  measuredDays: number;
  annualizedExecutions: number;
  lines: VarianceLine[];
  warnings: string[];
}

export function calculateRealized(input: RealizedInput): RealizedResult {
  const warnings: string[] = [];
  const b = input.baseline.metrics;
  const days = input.measurements.reduce((n, m) => n + m.periodDays, 0);
  const sum = (k: MeasurementKey) => input.measurements.reduce((n, m) => n + (m.metrics[k] ?? 0), 0);
  const execs = sum("executions");
  const bExecs = b.executions ?? 0;
  if (!bExecs) warnings.push("Baseline has no execution count — per-execution comparisons are unavailable.");
  if (!execs) warnings.push("No measured executions yet — realized ROI is unavailable.");
  const annualize = (v: number) => (days > 0 ? (v * 365) / days : 0);
  const annualExecs = annualize(execs);

  const perExec = (total: number | undefined, n: number) => (n > 0 && total != null ? total / n : null);
  const bCost = perExec(b.operating_cost, bExecs);
  const mCost = perExec(sum("operating_cost"), execs);
  const bHours = perExec(b.labor_hours, bExecs);
  const mHours = perExec(sum("labor_hours"), execs);

  const actualSavings = bCost != null && mCost != null ? (bCost - mCost) * annualExecs : null;
  const actualHours = bHours != null && mHours != null ? (bHours - mHours) * annualExecs : null;
  const bRevenueAnnual = input.baseline.periodDays > 0 ? ((b.revenue ?? 0) * 365) / input.baseline.periodDays : 0;
  const actualRevenueUplift = days > 0 ? annualize(sum("revenue")) - bRevenueAnnual : null;
  const actualNet = actualSavings != null ? actualSavings + (actualRevenueUplift ?? 0) : null;
  const cost = input.actualImplementationCost;
  const actualRoi3 = actualNet != null && cost > 0 ? ((actualNet * 3 - cost) / cost) * 100 : null;
  const actualPayback = actualNet != null && actualNet > 0 ? (cost / (actualNet / 12)) : null;
  if (cost <= 0) warnings.push("Actual implementation cost is 0 — record it on the implementation to compute realized ROI.");

  const provenance = weakest(input.baseline.provenance, ...input.measurements.map((m) => m.provenance));
  const line = (key: string, label: string, unit: RoiOutput["unit"], projected: number | null, actual: number | null): VarianceLine => {
    const variance = projected != null && actual != null ? round(actual - projected) : null;
    return {
      key, label, unit,
      projected: projected == null ? null : round(projected),
      actual: actual == null ? null : round(actual),
      variance,
      variancePct: variance != null && projected ? round((variance / Math.abs(projected)) * 100, 1) : null,
      provenance,
    };
  };
  return {
    modelVersion: ROI_MODEL_VERSION,
    measuredDays: days,
    annualizedExecutions: round(annualExecs),
    lines: [
      line("annualSavings", "Annual savings", "usd_per_year", input.projected.annualSavings, actualSavings),
      line("laborHoursRecoverable", "Recovered labor hours / year", "hours", input.projected.laborHoursRecoverable, actualHours),
      line("netAnnualBenefit", "Net annual benefit", "usd_per_year", input.projected.netAnnualBenefit, actualNet),
      line("roi3yrPct", "ROI (3 years)", "pct", input.projected.roi3yrPct, actualRoi3),
      line("paybackMonths", "Payback (months)", "months", input.projected.paybackMonths, actualPayback),
    ],
    warnings,
  };
}
