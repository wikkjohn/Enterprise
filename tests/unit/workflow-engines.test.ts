import { describe, expect, it } from "vitest";
import {
  calculateRealized, calculateRoi, guardRedesign, mapCsv, parseCsv, portfolioPosition, redesignResponseSchema, scoreWorkflow, weakest,
  type RedesignContext, type RoiInput,
} from "../../modules/workflow-intelligence/src";

const steps: RoiInput["steps"] = [
  { key: "t", name: "Trigger", type: "trigger", durationMinutes: 0, frequencyPerRun: 1, costPerExecution: 0, errorRate: 0, reworkRate: 0, automationPotential: "unknown", requiresApproval: false },
  { key: "a", name: "Key data", type: "human_task", durationMinutes: 6, frequencyPerRun: 1, costPerExecution: 0.5, errorRate: 0.05, reworkRate: 0.05, automationPotential: "high", requiresApproval: false },
  { key: "b", name: "Approve", type: "approval", durationMinutes: 4, frequencyPerRun: 1, costPerExecution: 0, errorRate: 0, reworkRate: 0, automationPotential: "high", requiresApproval: true },
  { key: "c", name: "Post", type: "system_action", durationMinutes: 30, frequencyPerRun: 1, costPerExecution: 0, errorRate: 0, reworkRate: 0, automationPotential: "unknown", requiresApproval: false },
];
const base: RoiInput = {
  annualVolume: 10_000,
  steps,
  costs: [
    { category: "implementation", period: "one_time", amount: 50_000, provenance: "fact" },
    { category: "software", period: "annual", amount: 5_000, provenance: "assumption" },
  ],
  assumptions: {
    loaded_hourly_rate: { value: 60, provenance: "fact" },
    adoption_rate: { value: 1, provenance: "fact" },
    ai_cost_per_execution: { value: 0.1, provenance: "fact" },
    approval_time_reduction: { value: 0.25, provenance: "fact" },
    error_reduction: { value: 0.5, provenance: "fact" },
  },
};

describe("ROI engine", () => {
  const r = calculateRoi(base);
  it("computes labor hours only for human step types, with rework", () => {
    // a: 6 min × 10k / 60 = 1000 h (+10% rework = 100 h); b: 4 min × 10k / 60 = 666.67 h. System action excluded.
    expect(r.outputs.currentAnnualHours.value).toBeCloseTo(1766.67, 1);
    // future: a 1000 × 0.2 = 200; rework 100 × 0.5 = 50; b 666.67 × 0.75 = 500 → 750
    expect(r.outputs.futureAnnualHours.value).toBeCloseTo(750, 1);
    expect(r.outputs.laborHoursRecoverable.value).toBeCloseTo(1016.67, 1);
  });
  it("computes costs, savings, net benefit, payback and multi-year ROI", () => {
    expect(r.outputs.annualSavings.value).toBeCloseTo(1016.67 * 60, 0);
    expect(r.outputs.currentAnnualCost.value).toBeCloseTo(1766.67 * 60 + 0.5 * 10_000, 0);
    expect(r.outputs.recurringAnnualCost.value).toBe(5_000 + 1_000);
    const net = 1016.6667 * 60 - 6_000;
    expect(r.outputs.netAnnualBenefit.value).toBeCloseTo(net, 0);
    expect(r.outputs.paybackMonths.value).toBeCloseTo(50_000 / (net / 12), 1);
    expect(r.outputs.roi1yrPct.value).toBeCloseTo(((net - 50_000) / 50_000) * 100, 0);
    expect(r.outputs.roi3yrPct.value).toBeCloseTo(((net * 3 - 50_000) / 50_000) * 100, 0);
    expect(r.outputs.roi5yrPct.value).toBeCloseTo(((net * 5 - 50_000) / 50_000) * 100, 0);
  });
  it("tags every output with a formula and the weakest provenance of its inputs", () => {
    for (const o of Object.values(r.outputs)) expect(o.formula.length).toBeGreaterThan(5);
    expect(r.outputs.implementationCost.provenance).toBe("fact");
    // annual software cost is an assumption, default_time_reduction unused → net benefit is an assumption.
    expect(r.outputs.netAnnualBenefit.provenance).toBe("assumption");
    expect(weakest("fact", "ai_estimate", "assumption")).toBe("ai_estimate");
  });
  it("uses defaults for missing assumptions and says so", () => {
    const d = calculateRoi({ ...base, assumptions: {} });
    const rate = d.inputs.find((i) => i.key === "loaded_hourly_rate")!;
    expect(rate).toMatchObject({ value: 60, provenance: "assumption", defaulted: true });
    expect(d.outputs.annualSavings.provenance).toBe("assumption");
  });
  it("never invents ROI without an implementation cost", () => {
    const d = calculateRoi({ ...base, costs: [] });
    expect(d.outputs.roi3yrPct.value).toBeNull();
    expect(d.outputs.roi3yrPct.note).toMatch(/implementation cost/);
    expect(d.warnings.join(" ")).toMatch(/No one-time implementation cost/);
  });
  it("clamps assumptions to their allowed range (approvals stay human)", () => {
    const d = calculateRoi({ ...base, assumptions: { ...base.assumptions, approval_time_reduction: { value: 1, provenance: "fact" } } });
    expect(d.stepBreakdown.find((s) => s.key === "b")!.reduction).toBe(0.6);
  });
});

describe("realized ROI", () => {
  it("annualizes per-execution deltas and reports variance against projection", () => {
    const res = calculateRealized({
      baseline: { periodDays: 30, metrics: { executions: 1000, labor_hours: 200, operating_cost: 12_000 }, provenance: "fact" },
      measurements: [{ periodDays: 30, metrics: { executions: 1000, labor_hours: 80, operating_cost: 6_000 }, provenance: "fact" }],
      actualImplementationCost: 40_000,
      projected: { annualSavings: 60_000, laborHoursRecoverable: 1_000, netAnnualBenefit: 55_000, roi3yrPct: 300, paybackMonths: 9 },
    });
    const savings = res.lines.find((l) => l.key === "annualSavings")!;
    // (12 − 6) $/exec × 1000 × 365/30
    expect(savings.actual).toBeCloseTo(6 * 1000 * (365 / 30), 0);
    expect(savings.variance).toBeCloseTo(savings.actual! - 60_000, 0);
    expect(savings.variancePct).toBeCloseTo(((savings.actual! - 60_000) / 60_000) * 100, 0);
    expect(res.lines.find((l) => l.key === "laborHoursRecoverable")!.actual).toBeCloseTo(0.12 * 1000 * (365 / 30), 0);
  });
  it("is unavailable (null, with warning) without measured executions", () => {
    const res = calculateRealized({ baseline: { periodDays: 30, metrics: { executions: 10, operating_cost: 100 }, provenance: "fact" }, measurements: [], actualImplementationCost: 1, projected: { annualSavings: 1, laborHoursRecoverable: 1, netAnnualBenefit: 1, roi3yrPct: 1, paybackMonths: 1 } });
    expect(res.lines.every((l) => l.actual === null)).toBe(true);
    expect(res.warnings.join(" ")).toMatch(/No measured executions/);
  });
});

describe("scoring", () => {
  const roi = calculateRoi(base);
  const input = {
    annualVolume: 10_000,
    riskCategory: "medium" as const,
    systems: ["ERP", "Email"],
    steps: [
      { type: "trigger" as const, role: null, system: "Email", durationMinutes: 0, frequencyPerRun: 1, sort: 0 },
      { type: "human_task" as const, role: "Clerk", system: "ERP", durationMinutes: 6, frequencyPerRun: 1, sort: 1 },
      { type: "approval" as const, role: "Manager", system: "ERP", durationMinutes: 4, frequencyPerRun: 1, sort: 2 },
    ],
    ratings: { repetitiveness: { value: 5, provenance: "fact" as const }, data_availability: { value: 5, provenance: "fact" as const }, data_quality: { value: 4, provenance: "assumption" as const } },
    roi,
  };
  const s = scoreWorkflow(input);
  it("derives 15 dimensions; unrated ones default to neutral 3 and are flagged", () => {
    expect(s.dimensions).toHaveLength(15);
    const hj = s.dimensions.find((d) => d.key === "human_judgment")!;
    expect(hj).toMatchObject({ rating: 3, defaulted: true, provenance: "assumption" });
    expect(s.dimensions.find((d) => d.key === "systems_count")!.rating).toBe(2);
    expect(s.dimensions.find((d) => d.key === "handoffs")!.rating).toBe(2); // Clerk → Manager
    expect(s.dimensions.find((d) => d.key === "volume")!.rating).toBe(4);
  });
  it("every score is the sum of its explained components", () => {
    for (const score of Object.values(s.scores)) {
      expect(score.value).toBeGreaterThanOrEqual(0);
      expect(score.value).toBeLessThanOrEqual(100);
      expect(score.components.length).toBeGreaterThan(0);
      expect(score.explanation.length).toBeGreaterThan(20);
      expect(score.value).toBeCloseTo(score.components.reduce((n, c) => n + c.contribution, 0), 0);
      for (const c of score.components) expect(c.detail.length).toBeGreaterThan(0);
    }
  });
  it("data readiness = 50% availability + 50% quality", () => {
    // (5−1)/4×50 + (4−1)/4×50 = 50 + 37.5
    expect(s.scores.dataReadiness.value).toBe(87.5);
    expect(s.scores.dataReadiness.provenance).toBe("assumption");
  });
  it("lists defaulted dimensions in the explanation", () => {
    expect(s.scores.automationReadiness.defaultedDimensions).toEqual(expect.arrayContaining(["integration_availability", "decision_complexity", "error_tolerance"]));
    expect(s.scores.automationReadiness.explanation).toMatch(/assumed neutral/);
  });
  it("places the workflow in a portfolio quadrant with an explanation", () => {
    const pos = portfolioPosition(s.scores);
    expect(["quick_win", "strategic_bet", "fill_in", "deprioritize"]).toContain(pos.quadrant);
    expect(pos.explanation).toMatch(/Value = 60% AI Opportunity/);
  });
});

describe("CSV import parsing", () => {
  it("handles quotes, escaped quotes, CRLF and embedded newlines", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\n')).toEqual([["a", "b"], ["x, y", 'say "hi"\nthere']]);
  });
  it("maps header aliases and reports unknown columns", () => {
    const { rows, unknownHeaders } = mapCsv("Workflow Name,Dept,Annual Volume,Systems,Colour\nInvoices,Finance,\"1,200\",ERP; Email,red\n");
    expect(rows[0]!.values).toMatchObject({ name: "Invoices", department: "Finance", annualVolume: "1,200", systems: "ERP; Email" });
    expect(unknownHeaders).toEqual(["Colour"]);
  });
  it("requires a name column", () => {
    expect(() => mapCsv("dept\nFinance\n")).toThrow(/name/);
  });
});

describe("redesign guard", () => {
  const current: RedesignContext = {
    name: "Invoices", description: "", department: "Finance", riskCategory: "medium", regulatoryCategory: null, annualVolume: 1000,
    steps: [
      { key: "in", type: "trigger", name: "Invoice in", description: "", role: null, system: null, durationMinutes: 0, waitMinutes: 0, requiresApproval: false, risk: "low" },
      { key: "key", type: "human_task", name: "Key data", description: "", role: "Clerk", system: "ERP", durationMinutes: 6, waitMinutes: 0, requiresApproval: false, risk: "low" },
      { key: "ok", type: "approval", name: "Manager approval", description: "", role: "Manager", system: "ERP", durationMinutes: 3, waitMinutes: 0, requiresApproval: true, risk: "medium" },
      { key: "pay", type: "human_task", name: "Release payment", description: "", role: "Treasury", system: "Bank", durationMinutes: 2, waitMinutes: 0, requiresApproval: true, risk: "high" },
      { key: "done", type: "completion", name: "Done", description: "", role: null, system: null, durationMinutes: 0, waitMinutes: 0, requiresApproval: false, risk: "low" },
    ],
    edges: [{ from: "in", to: "key" }, { from: "key", to: "ok" }, { from: "ok", to: "pay" }, { from: "pay", to: "done" }],
  };
  const response = redesignResponseSchema.parse({
    summary: "Extract with AI and auto-approve.",
    futureSteps: [
      { key: "in", type: "trigger", name: "Invoice in" },
      { key: "extract", type: "ai_task", name: "AI extraction", change: "added" },
      { key: "pay", type: "system_action", name: "Auto release", change: "automated" },
      { key: "done", type: "completion", name: "Done" },
    ],
    futureEdges: [{ from: "in", to: "extract" }, { from: "extract", to: "pay" }, { from: "pay", to: "done" }, { from: "extract", to: "ghost" }],
    removedSteps: [{ key: "key", reason: "Replaced by AI extraction" }, { key: "ok", reason: "AI is accurate enough" }],
    estimates: { timeReductionPct: 70, costReductionPct: 60 },
  });
  const { proposal, warnings } = guardRedesign(current, response);
  it("restores a removed approval step and re-wires its edges", () => {
    const ok = proposal.futureSteps.find((s) => s.key === "ok");
    expect(ok).toMatchObject({ type: "approval", requiresApproval: true });
    expect(proposal.removedSteps.map((r) => r.key)).toEqual(["key"]);
    expect(proposal.futureEdges).toEqual(expect.arrayContaining([{ from: "ok", to: "pay", label: null }]));
    expect(warnings.some((w) => w.includes("Manager approval") && w.includes("restored"))).toBe(true);
  });
  it("keeps the human control on a step the model tried to automate", () => {
    expect(proposal.futureSteps.find((s) => s.key === "pay")!.requiresApproval).toBe(true);
    expect(warnings.some((w) => w.includes("Release payment") && w.includes("automated"))).toBe(true);
    expect(proposal.restoredControls.sort()).toEqual(["ok", "pay"]);
    expect(proposal.humanApprovals).toEqual(expect.arrayContaining(["ok", "pay"]));
  });
  it("drops dangling edges, flags missing exception paths and tags numbers as AI estimates", () => {
    expect(proposal.futureEdges.some((e) => e.to === "ghost")).toBe(false);
    expect(warnings.some((w) => w.includes("ghost"))).toBe(true);
    expect(warnings.some((w) => w.includes("without an exception path"))).toBe(true);
    expect(proposal.provenance).toBe("ai_estimate");
    expect(proposal.aiSteps).toEqual(["extract"]);
  });
});
