import { describe, expect, it } from "vitest";
import { allocate, budgetStatus, periodWindow, runRateForecast, trendForecast } from "../../modules/ai-operations/src/budget";
import { costPerValueDollar, departmentAdoption, unitMetric } from "../../modules/ai-operations/src/economics";
import { abnormalUsage, costSpikes, duplicateTools, expensiveModels, idleTools, underutilizedContracts, unusedLicenses } from "../../modules/ai-operations/src/optimize";
import { applyPolicy, compliance, selectPolicy, type ModelPolicy } from "../../modules/ai-operations/src/policies";
import { nextStage, progress, TransitionError } from "../../modules/ai-operations/src/requests";

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe("budget periods", () => {
  it("monthly, fiscal quarters and fiscal years", () => {
    expect(periodWindow("monthly", d("2026-10-06"))).toMatchObject({ key: "M:2026-10", label: "Oct 2026", start: d("2026-10-01"), end: d("2026-11-01") });
    // Fiscal year starting in July: Oct 2026 is Q2 FY2027.
    expect(periodWindow("quarterly", d("2026-10-06"), 7)).toMatchObject({ label: "Q2 FY2027", start: d("2026-10-01"), end: d("2027-01-01") });
    expect(periodWindow("annual", d("2026-03-15"), 7)).toMatchObject({ label: "FY2026", start: d("2025-07-01"), end: d("2026-07-01") });
    expect(periodWindow("quarterly", d("2026-02-10"))).toMatchObject({ label: "Q1 FY2026", start: d("2026-01-01"), end: d("2026-04-01") });
    expect(periodWindow("annual", d("2026-02-10"))).toMatchObject({ label: "FY2026", start: d("2026-01-01"), end: d("2027-01-01") });
  });
  it("run-rate forecasts and threshold status", () => {
    const w = periodWindow("monthly", d("2026-10-01"));
    expect(runRateForecast(1000, w, d("2026-10-11"))).toBe(3100);
    expect(budgetStatus({ amount: 10_000, spent: 2_000, projected: 6_000, thresholds: [80, 100] })).toMatchObject({ status: "ok", crossed: [], pctSpent: 20 });
    expect(budgetStatus({ amount: 10_000, spent: 5_000, projected: 15_500, thresholds: [80, 100] }).status).toBe("at_risk");
    expect(budgetStatus({ amount: 10_000, spent: 8_500, projected: 9_000, thresholds: [100, 80, 50] })).toMatchObject({ status: "warning", crossed: [50, 80] });
    expect(budgetStatus({ amount: 10_000, spent: 10_000, projected: 12_000, thresholds: [80, 100] })).toMatchObject({ status: "exceeded", crossed: [80, 100], remaining: 0 });
  });
  it("trend forecasts follow a linear trend and fall back to an average", () => {
    const f = trendForecast([100, 200, 300, 400], 2);
    expect(f.method).toBe("linear_trend");
    expect(f.values).toEqual([500, 600]);
    expect(f.low[0]).toBeLessThanOrEqual(500);
    expect(trendForecast([100, 300], 1)).toMatchObject({ method: "average", values: [200] });
    expect(trendForecast([300, 200, 100], 3).values.every((v) => v >= 0)).toBe(true);
  });
  it("allocation splits to the cent and sums exactly", () => {
    const a = allocate(100, { Sales: 1, Finance: 1, HR: 1 });
    expect(Object.values(a).reduce((x, y) => x + y, 0)).toBeCloseTo(100, 10);
    expect(Object.values(a).sort()).toEqual([33.33, 33.33, 33.34]);
    expect(allocate(1000, { A: 3, B: 1, C: 0 })).toEqual({ A: 750, B: 250 });
    expect(allocate(50, {})).toEqual({});
  });
});

describe("optimization detectors", () => {
  const tools = [
    { id: "t1", name: "WriterPro", category: "writing_assistant", status: "approved", departments: ["Marketing"], annualCost: 12_000, licensedSeats: 50, vendorId: "v1" },
    { id: "t2", name: "CopyGenie", category: "writing_assistant", status: "experimental", departments: ["Marketing", "Sales"], annualCost: 6_000, licensedSeats: 20, vendorId: "v2" },
    { id: "t3", name: "OldBot", category: "chat_assistant", status: "approved", departments: [], annualCost: 3_000, licensedSeats: 10, vendorId: null },
    { id: "t4", name: "Legacy", category: "writing_assistant", status: "retiring", departments: ["Marketing"], annualCost: 9_000, licensedSeats: 10, vendorId: null },
  ];
  it("unused licenses and idle tools are priced per seat", () => {
    const f = unusedLicenses(tools, [{ toolId: "t1", active: 30, unused: 20, neverUsed: 5 }, { toolId: "t2", active: 20, unused: 1, neverUsed: 0 }], 30);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: "unused_licenses", toolId: "t1", estimatedAnnualSavings: 4800 });
    expect(idleTools(tools, [{ toolId: "t3", active: 0, unused: 10, neverUsed: 10 }], 60)[0]).toMatchObject({ kind: "idle_tool", estimatedAnnualSavings: 3000 });
  });
  it("duplicate tools ignore retiring ones and keep the largest contract", () => {
    const f = duplicateTools(tools);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: "duplicate_tools", estimatedAnnualSavings: 6000 });
    expect(JSON.stringify(f[0]!.evidence)).not.toContain("Legacy");
  });
  it("flags premium models on simple tasks only when an approved cheaper model exists", () => {
    const usage = { useCase: "ticket.classify", moduleId: "core", provider: "p", model: "big", tier: "premium" as const, dataClassification: "internal", runs: 1000, inputTokens: 500_000, outputTokens: 50_000, cost: 52.5, days: 30 };
    const prices = [{ provider: "p", model: "small", tier: "economy" as const, inputCostPerMtok: 0.25, outputCostPerMtok: 1.25, maxDataClassification: "internal" }];
    const f = expensiveModels([usage], prices, { maxAvgInput: 2000, maxAvgOutput: 400, minRuns: 50 });
    expect(f[0]).toMatchObject({ kind: "expensive_model" });
    expect(f[0]!.estimatedAnnualSavings).toBeGreaterThan(500);
    expect(expensiveModels([{ ...usage, dataClassification: "confidential" }], prices, { maxAvgInput: 2000, maxAvgOutput: 400, minRuns: 50 })).toHaveLength(0);
    expect(expensiveModels([{ ...usage, inputTokens: 5_000_000 }], prices, { maxAvgInput: 2000, maxAvgOutput: 400, minRuns: 50 })).toHaveLength(0);
  });
  it("abnormal usage and cost spikes against a baseline", () => {
    const days = (vals: number[]) => vals.map((v, i) => ({ day: `2026-09-${String(i + 1).padStart(2, "0")}`, value: v }));
    const flat = Array.from({ length: 14 }, () => 1000);
    expect(abnormalUsage([{ key: "m", label: "core", values: days([...flat, 9000]) }], { baselineDays: 14, z: 3, minRatio: 2, minValue: 100, unit: "tokens" })).toHaveLength(1);
    expect(abnormalUsage([{ key: "m", label: "core", values: days([...flat, 1100]) }], { baselineDays: 14, z: 3, minRatio: 2, minValue: 100, unit: "tokens" })).toHaveLength(0);
    const spend = days([...Array.from({ length: 28 }, () => 10), ...Array.from({ length: 7 }, () => 40)].slice(0, 30));
    const s = costSpikes([{ key: "all", label: "AI", values: spend }], { thresholdPct: 50, minWeekly: 10 });
    expect(s[0]).toMatchObject({ kind: "cost_spike" });
  });
  it("underutilized contracts", () => {
    expect(underutilizedContracts([{ id: "c", name: "API commit", vendorId: "v", committedAnnual: 100_000, actualAnnualized: 40_000, renewalDate: "2027-01-01" }], 70)[0]).toMatchObject({ estimatedAnnualSavings: 60_000 });
    expect(underutilizedContracts([{ id: "c", name: "API commit", vendorId: "v", committedAnnual: 100_000, actualAnnualized: 90_000, renewalDate: null }], 70)).toHaveLength(0);
  });
});

describe("model routing policies", () => {
  const models = [
    { providerKey: "p", modelKey: "small", tier: "economy" as const, capabilities: ["text"], inputCostPerMtok: 0.25, outputCostPerMtok: 1.25 },
    { providerKey: "p", modelKey: "mid", tier: "standard" as const, capabilities: ["text"], inputCostPerMtok: 3, outputCostPerMtok: 15 },
    { providerKey: "eu", modelKey: "big", tier: "premium" as const, capabilities: ["text", "long_context"], inputCostPerMtok: 15, outputCostPerMtok: 75 },
  ];
  const pol = (o: Partial<Omit<ModelPolicy, "match" | "rules">> & { id: string; match?: Partial<ModelPolicy["match"]>; rules?: Partial<ModelPolicy["rules"]> }): ModelPolicy => ({
    name: o.id, priority: 100, enforcement: "enforced", status: "active", ...o,
    match: { useCases: [], modules: [], dataClassifications: [], ...o.match },
    rules: { allowedTiers: [], preferredTier: null, allowedModels: [], blockedModels: [], allowedProviders: [], requiredCapabilities: [], maxCostPerMtok: null, maxLatencyMs: null, ...o.rules },
  });
  const classify = pol({ id: "classification", match: { useCases: ["*.classify"], modules: [], dataClassifications: [] }, rules: { allowedTiers: ["economy", "standard"], preferredTier: "economy" } });
  const legal = pol({ id: "legal", priority: 10, match: { useCases: ["legal.*"], modules: [], dataClassifications: ["confidential", "restricted"] }, rules: { allowedTiers: ["premium"], allowedProviders: ["eu"], requiredCapabilities: ["long_context"] } });

  it("selects the governing policy by match, priority and specificity", () => {
    expect(selectPolicy([classify, legal], { useCase: "ticket.classify", moduleId: "core", dataClassification: "internal" })?.id).toBe("classification");
    expect(selectPolicy([classify, legal], { useCase: "legal.review", moduleId: "core", dataClassification: "confidential" })?.id).toBe("legal");
    expect(selectPolicy([classify, legal], { useCase: "legal.review", moduleId: "core", dataClassification: "internal" })).toBeNull();
    expect(selectPolicy([{ ...classify, status: "disabled" }], { useCase: "ticket.classify", moduleId: "core", dataClassification: "internal" })).toBeNull();
  });
  it("filters and orders candidates; nothing qualifying means an empty list", () => {
    expect(applyPolicy(classify, [...models].reverse()).allowed.map((m) => m.modelKey)).toEqual(["small", "mid"]);
    expect(applyPolicy(legal, models).allowed.map((m) => m.modelKey)).toEqual(["big"]);
    const strict = pol({ id: "cheap", rules: { maxCostPerMtok: 1 } });
    const r = applyPolicy(strict, models);
    expect(r.allowed).toEqual([]);
    expect(r.excluded.map((e) => e.reason)).toContain("cheap: above the cost ceiling");
  });
  it("reports compliance and savings without changing anything", () => {
    const rows = compliance([classify], [
      { useCase: "ticket.classify", moduleId: "core", dataClassification: "internal", provider: "eu", model: "big", tier: "premium", capabilities: ["text"], inputCostPerMtok: 15, outputCostPerMtok: 75, runs: 100, cost: 3, inputTokens: 100_000, outputTokens: 20_000, medianLatencyMs: null },
      { useCase: "ticket.classify", moduleId: "core", dataClassification: "internal", provider: "p", model: "small", tier: "economy", capabilities: ["text"], inputCostPerMtok: 0.25, outputCostPerMtok: 1.25, runs: 50, cost: 0.05, inputTokens: 50_000, outputTokens: 10_000, medianLatencyMs: null },
    ], models);
    expect(rows[0]).toMatchObject({ runs: 150, compliantRuns: 50 });
    expect(rows[0]!.potentialSavings).toBeGreaterThan(2.9);
  });
});

describe("request workflow", () => {
  it("walks the review stages in order", () => {
    let s = nextStage("submitted", { type: "start_review" });
    for (const expected of ["security_review", "technical_review", "financial_review", "approved"] as const) {
      s = nextStage(s, { type: "review", decision: "approve" });
      expect(s).toBe(expected);
    }
    expect(nextStage("approved", { type: "start_implementation" })).toBe("implementation");
    expect(nextStage("implementation", { type: "start_measurement" })).toBe("measurement");
    expect(nextStage("measurement", { type: "close" })).toBe("closed");
  });
  it("rejects, returns for changes, allows not-applicable stages and refuses invalid moves", () => {
    expect(nextStage("security_review", { type: "review", decision: "reject" })).toBe("rejected");
    expect(nextStage("technical_review", { type: "review", decision: "request_changes" })).toBe("submitted");
    expect(nextStage("security_review", { type: "review", decision: "not_applicable" })).toBe("technical_review");
    expect(() => nextStage("submitted", { type: "start_implementation" })).toThrow(TransitionError);
    expect(() => nextStage("approved", { type: "review", decision: "approve" })).toThrow(/approved/);
    expect(() => nextStage("submitted", { type: "start_review" }, { changesRequested: true })).toThrow(/resubmit/);
    expect(() => nextStage("approved", { type: "withdraw" })).toThrow(TransitionError);
    expect(progress("technical_review").filter((p) => p.state === "done").map((p) => p.stage)).toEqual(["submitted", "business_review", "security_review"]);
  });
});

describe("adoption and unit economics", () => {
  it("suppresses small groups and never exposes individuals", () => {
    const a = departmentAdoption([
      { department: "Sales", members: 40, licensed: 30, active: 20, aiRuns: 400, trainingRequired: 40, trainingCompleted: 30 },
      { department: "Legal", members: 3, licensed: 3, active: 3, aiRuns: 90, trainingRequired: 3, trainingCompleted: 1 },
    ]);
    expect(a[0]).toMatchObject({ department: "Sales", suppressed: false, activePct: 50, aiRunsPerActiveUser: 20, trainingCompletionPct: 75 });
    expect(a[1]).toMatchObject({ department: "Legal", suppressed: true, active: null, members: null, trainingCompletionPct: null });
  });
  it("keeps measured, estimated and allocated cost separate per unit", () => {
    const m = unitMetric("per_user", "Cost per active user", "active user", { measured: 900, estimated: 300, allocated: 600 }, 30, "Active users");
    expect(m.perUnit).toEqual({ measured: 30, estimated: 10, allocated: 20 });
    expect(m.total).toBe(60);
    expect(unitMetric("x", "x", "x", { measured: 1, estimated: 0, allocated: 0 }, 0, "").perUnit).toBeNull();
    expect(costPerValueDollar({ measured: 50_000, estimated: 0, allocated: 0 }, 200_000).total).toBe(0.25);
  });
});
