import { round2 } from "./budget";

/**
 * Cost-optimization detectors. Each returns recommendations only — the module
 * never switches a production model, revokes a license or cancels a contract.
 * Savings are estimates and are labelled as such.
 */

export const FINDING_KINDS = ["unused_licenses", "duplicate_tools", "expensive_model", "abnormal_tokens", "idle_tool", "cost_spike", "underutilized_contract"] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export interface Finding {
  kind: FindingKind;
  /** Stable across scans, so a finding is updated rather than duplicated. */
  dedupeKey: string;
  title: string;
  detail: string;
  recommendation: string;
  severity: "low" | "medium" | "high";
  estimatedAnnualSavings: number;
  toolId?: string | null;
  vendorId?: string | null;
  contractId?: string | null;
  modelKey?: string | null;
  evidence: Record<string, unknown>;
}

const sev = (savings: number): Finding["severity"] => (savings >= 25_000 ? "high" : savings >= 2_500 ? "medium" : "low");
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

// ── Licenses ────────────────────────────────────────────────────────────────

export interface ToolForOptimization {
  id: string;
  name: string;
  category: string;
  status: string;
  departments: string[];
  annualCost: number;
  licensedSeats: number;
  vendorId: string | null;
}
export interface LicenseActivity { toolId: string; active: number; unused: number; neverUsed: number }

export function unusedLicenses(tools: ToolForOptimization[], activity: LicenseActivity[], days: number): Finding[] {
  const out: Finding[] = [];
  for (const t of tools) {
    const a = activity.find((x) => x.toolId === t.id);
    if (!a || a.unused <= 0 || t.status === "retiring") continue;
    const assigned = a.active + a.unused;
    const seatCost = t.annualCost > 0 && Math.max(t.licensedSeats, assigned) > 0 ? t.annualCost / Math.max(t.licensedSeats, assigned) : 0;
    // Small tools: only flag when at least 2 seats or 10 % are unused.
    if (a.unused < 2 && a.unused / Math.max(1, assigned) < 0.1) continue;
    const savings = round2(seatCost * a.unused);
    out.push({
      kind: "unused_licenses", dedupeKey: `unused:${t.id}`, toolId: t.id, vendorId: t.vendorId,
      title: `${a.unused} unused ${t.name} license${a.unused === 1 ? "" : "s"}`,
      detail: `${a.unused} of ${assigned} assigned licenses had no recorded activity in the last ${days} days (${a.neverUsed} never used).${seatCost ? ` At about ${usd(seatCost)} per seat per year.` : " Seat cost unknown."}`,
      recommendation: "Confirm with the business owner, then reclaim or reassign the seats before the next true-up or renewal.",
      severity: sev(savings), estimatedAnnualSavings: savings, evidence: { assigned, unused: a.unused, neverUsed: a.neverUsed, windowDays: days, seatCost: round2(seatCost) },
    });
  }
  return out;
}

/** Tools that only cost money: no active users in the window although they have a cost. */
export function idleTools(tools: ToolForOptimization[], activity: LicenseActivity[], days: number): Finding[] {
  return tools.filter((t) => t.annualCost > 0 && t.status !== "retiring").flatMap((t) => {
    const a = activity.find((x) => x.toolId === t.id);
    if (!a || a.active > 0 || a.unused === 0) return [];
    return [{
      kind: "idle_tool" as const, dedupeKey: `idle:${t.id}`, toolId: t.id, vendorId: t.vendorId,
      title: `${t.name} has had no active users for ${days} days`,
      detail: `${a.unused} license(s) are assigned but none was used in the last ${days} days; the tool costs ${usd(t.annualCost)} per year.`,
      recommendation: "Ask the business owner whether the tool is still needed; if not, mark it Retiring and plan the exit at renewal.",
      severity: sev(t.annualCost), estimatedAnnualSavings: round2(t.annualCost), evidence: { assigned: a.unused, windowDays: days, annualCost: t.annualCost },
    }];
  });
}

/** Two or more non-retiring tools in the same category serving overlapping departments. */
export function duplicateTools(tools: ToolForOptimization[]): Finding[] {
  const groups = new Map<string, ToolForOptimization[]>();
  for (const t of tools) {
    if (t.status === "retiring" || t.status === "restricted" || !t.category || t.category === "other") continue;
    groups.set(t.category, [...(groups.get(t.category) ?? []), t]);
  }
  const out: Finding[] = [];
  for (const [category, list] of groups) {
    if (list.length < 2) continue;
    const overlapping = list.filter((a) => list.some((b) => b !== a && (a.departments.length === 0 || b.departments.length === 0 || a.departments.some((d) => b.departments.includes(d)))));
    if (overlapping.length < 2) continue;
    const sorted = [...overlapping].sort((a, b) => b.annualCost - a.annualCost || a.name.localeCompare(b.name));
    // Keep the most-strategic/most-used candidate implicitly: savings = all but the largest contract.
    const savings = round2(sorted.slice(1).reduce((s, t) => s + t.annualCost, 0));
    out.push({
      kind: "duplicate_tools", dedupeKey: `dup:${category}:${sorted.map((t) => t.id).sort().join(",")}`, toolId: sorted[0]!.id,
      title: `${sorted.length} overlapping ${category.replace(/_/g, " ")} tools`,
      detail: `${sorted.map((t) => `${t.name} (${usd(t.annualCost)}/yr)`).join(", ")} serve overlapping departments.`,
      recommendation: "Compare capability, adoption and security posture; standardise on one tool and retire the others at their renewals. Savings assume keeping the largest contract.",
      severity: sev(savings), estimatedAnnualSavings: savings, evidence: { category, tools: sorted.map((t) => ({ id: t.id, name: t.name, annualCost: t.annualCost, departments: t.departments })) },
    });
  }
  return out;
}

const CLASS_RANK: Record<string, number> = { public: 0, internal: 1, confidential: 2, restricted: 3 };

// ── Models ──────────────────────────────────────────────────────────────────

export interface ModelUsage {
  useCase: string;
  moduleId: string;
  provider: string;
  model: string;
  tier: "economy" | "standard" | "premium";
  /** Highest data classification seen for these runs. */
  dataClassification: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  /** Days of usage the totals cover. */
  days: number;
}
export interface ModelPrice { provider: string; model: string; tier: "economy" | "standard" | "premium"; inputCostPerMtok: number; outputCostPerMtok: number; maxDataClassification: string }

/**
 * Premium/standard models used for short, simple requests (small inputs and
 * outputs on average) where a cheaper approved model exists. Thresholds are
 * deliberately conservative; quality must be validated before switching.
 */
export function expensiveModels(usage: ModelUsage[], prices: ModelPrice[], opts: { maxAvgInput: number; maxAvgOutput: number; minRuns: number }): Finding[] {
  const out: Finding[] = [];
  for (const u of usage) {
    if (u.tier === "economy" || u.runs < opts.minRuns || u.cost <= 0) continue;
    const avgIn = u.inputTokens / u.runs;
    const avgOut = u.outputTokens / u.runs;
    if (avgIn > opts.maxAvgInput || avgOut > opts.maxAvgOutput) continue;
    const cheaper = prices
      .filter((p) => p.tier === "economy" && CLASS_RANK[p.maxDataClassification]! >= CLASS_RANK[u.dataClassification]!)
      .map((p) => ({ p, cost: (u.inputTokens * p.inputCostPerMtok + u.outputTokens * p.outputCostPerMtok) / 1e6 }))
      .sort((a, b) => a.cost - b.cost)[0];
    if (!cheaper || cheaper.cost >= u.cost * 0.7) continue;
    const annual = round2(((u.cost - cheaper.cost) * 365) / Math.max(1, u.days));
    out.push({
      kind: "expensive_model", dedupeKey: `model:${u.moduleId}:${u.useCase}:${u.provider}/${u.model}`, modelKey: `${u.provider}/${u.model}`,
      title: `${u.model} (${u.tier}) used for simple "${u.useCase}" requests`,
      detail: `${u.runs} runs in ${u.days} days averaged ${Math.round(avgIn)} input and ${Math.round(avgOut)} output tokens, costing ${usd(u.cost)}. The economy model ${cheaper.p.model} would have cost about ${usd(cheaper.cost)} for the same tokens.`,
      recommendation: `Evaluate ${cheaper.p.model} on a sample of "${u.useCase}" requests; if quality holds, add a model routing policy for this use case. Nothing is switched automatically.`,
      severity: sev(annual), estimatedAnnualSavings: annual,
      evidence: { useCase: u.useCase, moduleId: u.moduleId, runs: u.runs, avgInputTokens: Math.round(avgIn), avgOutputTokens: Math.round(avgOut), cost: round2(u.cost), alternative: `${cheaper.p.provider}/${cheaper.p.model}`, alternativeCost: round2(cheaper.cost), days: u.days },
    });
  }
  return out;
}

// ── Anomalies ───────────────────────────────────────────────────────────────

export interface DailySeries { key: string; label: string; values: Array<{ day: string; value: number }> }

/**
 * Latest day far above its trailing baseline: more than `z` standard
 * deviations above the mean of the previous `baselineDays`, and at least
 * `minRatio` × that mean (so flat, tiny series do not trigger).
 */
export function abnormalUsage(series: DailySeries[], opts: { baselineDays: number; z: number; minRatio: number; minValue: number; unit: string }): Finding[] {
  const out: Finding[] = [];
  for (const s of series) {
    const vals = [...s.values].sort((a, b) => a.day.localeCompare(b.day));
    if (vals.length < Math.min(7, opts.baselineDays) + 1) continue;
    const last = vals[vals.length - 1]!;
    const base = vals.slice(-opts.baselineDays - 1, -1).map((v) => v.value);
    const mean = base.reduce((a, b) => a + b, 0) / base.length;
    const sd = Math.sqrt(base.reduce((a, b) => a + (b - mean) ** 2, 0) / base.length);
    if (last.value < opts.minValue || last.value < mean * opts.minRatio || last.value <= mean + opts.z * Math.max(sd, mean * 0.05)) continue;
    out.push({
      kind: "abnormal_tokens", dedupeKey: `abnormal:${s.key}:${last.day}`,
      title: `Unusual ${opts.unit} volume for ${s.label} on ${last.day}`,
      detail: `${Math.round(last.value).toLocaleString("en-US")} ${opts.unit} versus a ${base.length}-day average of ${Math.round(mean).toLocaleString("en-US")} (${(last.value / Math.max(1, mean)).toFixed(1)}×).`,
      recommendation: "Check for a runaway job, a retry loop, a prompt that grew unexpectedly or misuse. Rate limits and budgets in the AI layer cap the damage.",
      severity: last.value > mean * 5 ? "high" : "medium", estimatedAnnualSavings: 0, evidence: { series: s.key, day: last.day, value: last.value, baselineMean: Math.round(mean), baselineSd: Math.round(sd) },
    });
  }
  return out;
}

/** Last 7 days of spend vs the previous 28-day weekly average. */
export function costSpikes(series: DailySeries[], opts: { thresholdPct: number; minWeekly: number }): Finding[] {
  const out: Finding[] = [];
  for (const s of series) {
    const vals = [...s.values].sort((a, b) => a.day.localeCompare(b.day));
    if (vals.length < 14) continue;
    const recent = vals.slice(-7).reduce((a, v) => a + v.value, 0);
    const prior = vals.slice(-35, -7);
    const weekly = (prior.reduce((a, v) => a + v.value, 0) / Math.max(1, prior.length)) * 7;
    if (recent < opts.minWeekly || weekly <= 0) continue;
    const pct = ((recent - weekly) / weekly) * 100;
    if (pct < opts.thresholdPct) continue;
    const annualExtra = round2((recent - weekly) * 52);
    out.push({
      kind: "cost_spike", dedupeKey: `spike:${s.key}:${vals[vals.length - 1]!.day.slice(0, 7)}`,
      title: `${s.label} spend up ${Math.round(pct)} % this week`,
      detail: `${usd(recent)} in the last 7 days versus a weekly average of ${usd(weekly)} over the previous ${prior.length} days.`,
      recommendation: "Find what changed (new use case, model, volume or a misconfiguration). If the increase is expected, adjust the budget; otherwise fix the cause.",
      severity: pct >= 200 ? "high" : "medium", estimatedAnnualSavings: Math.max(0, annualExtra), evidence: { series: s.key, last7: round2(recent), weeklyAverage: round2(weekly), pct: Math.round(pct) },
    });
  }
  return out;
}

// ── Contracts ───────────────────────────────────────────────────────────────

export interface ContractUtilization { id: string; name: string; vendorId: string; committedAnnual: number; actualAnnualized: number; renewalDate: string | null }

/** Committed spend well above what is actually being consumed. */
export function underutilizedContracts(contracts: ContractUtilization[], minUtilizationPct: number): Finding[] {
  return contracts.flatMap((c) => {
    if (c.committedAnnual <= 0) return [];
    const pct = (c.actualAnnualized / c.committedAnnual) * 100;
    if (pct >= minUtilizationPct) return [];
    const savings = round2(c.committedAnnual - c.actualAnnualized);
    return [{
      kind: "underutilized_contract" as const, dedupeKey: `contract:${c.id}`, contractId: c.id, vendorId: c.vendorId,
      title: `${c.name} is ${Math.round(pct)} % utilized`,
      detail: `Committed ${usd(c.committedAnnual)} per year; consumption is running at about ${usd(c.actualAnnualized)} per year.${c.renewalDate ? ` Renews ${c.renewalDate}.` : ""}`,
      recommendation: "Right-size the commitment at renewal, or move more approved workloads onto it before then.",
      severity: sev(savings), estimatedAnnualSavings: savings, evidence: { committedAnnual: c.committedAnnual, actualAnnualized: round2(c.actualAnnualized), utilizationPct: Math.round(pct) },
    }];
  });
}
