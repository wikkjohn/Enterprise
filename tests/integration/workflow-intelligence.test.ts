import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AIProvider } from "../../packages/ai/src";
import { aiRuns, auditEvents, and, eq, eventOutbox } from "../../packages/db/src";
import { workflowService, type WorkflowService } from "../../modules/workflow-intelligence/src";
import { addMember, createOrg, createTestPlatform, expectCode } from "../helpers/platform";

type P = Awaited<ReturnType<typeof createTestPlatform>>;

/** Fake model (replaces the sandbox provider kind) returning a structured redesign that tries to drop the approval. */
const redesignProvider: AIProvider = {
  kind: "sandbox",
  async generate(req) {
    const text = JSON.stringify({
      summary: "Let AI extract and route; remove the manual approval.",
      futureSteps: [
        { key: "start", type: "trigger", name: "Request received" },
        { key: "extract", type: "ai_task", name: "AI extracts fields", change: "added", durationMinutes: 0 },
        { key: "done", type: "completion", name: "Done" },
      ],
      futureEdges: [{ from: "start", to: "extract" }, { from: "extract", to: "done" }],
      removedSteps: [{ key: "enter", reason: "AI extraction" }, { key: "approve", reason: "Not needed" }],
      exceptionPaths: [{ trigger: "Low confidence", handling: "Route to clerk" }],
      requirements: { integration: ["ERP API"], data: ["Labeled examples"], security: ["PII redaction"] },
      estimates: { timeReductionPct: 65, costReductionPct: 50, rationale: "Typing removed" },
      confidence: "medium",
    });
    return { text, servedModel: req.model, finishReason: "stop", usage: { inputTokens: 100, outputTokens: 200 } };
  },
};

let p: P;
let svc: WorkflowService;
let A: Awaited<ReturnType<typeof createOrg>>;
let B: Awaited<ReturnType<typeof createOrg>>;

const graph = {
  steps: [
    { key: "start", type: "trigger" as const, name: "Request received", position: { x: 0, y: 0 } },
    { key: "enter", type: "human_task" as const, name: "Enter data", role: "Clerk", system: "ERP", durationMinutes: 10, errorRate: 0.05, automationPotential: "high" as const },
    { key: "approve", type: "approval" as const, name: "Manager approval", role: "Manager", durationMinutes: 5, requiresApproval: true },
    { key: "done", type: "completion" as const, name: "Done" },
  ],
  edges: [{ from: "start", to: "enter" }, { from: "enter", to: "approve" }, { from: "approve", to: "done" }],
};

beforeAll(async () => {
  p = await createTestPlatform({ extraAIProviders: [redesignProvider] });
  svc = workflowService(p);
  A = await createOrg(p);
  B = await createOrg(p);
  await p.modules.enable(A.adminCtx(), "workflow_intelligence");
  await p.modules.enable(B.adminCtx(), "workflow_intelligence");
});
afterAll(() => p.close());

describe("Workflow Intelligence — module registration", () => {
  it("registers permissions, events and notification types in the SHARED registries", () => {
    expect(p.rbac.registry.get("workflow.roi.manage")?.owner).toBe("workflow_intelligence");
    for (const t of ["workflow.created", "workflow.analyzed", "workflow.opportunity.created", "workflow.approved", "workflow.implementation.started", "workflow.production.started", "workflow.roi.measured"]) {
      expect(p.events.registry.get(t)?.owner).toBe("workflow_intelligence");
    }
    expect(p.notificationTypes.get("workflow.opportunity_identified")).toBeTruthy();
  });
  it("is unusable until enabled for the organization", async () => {
    const C = await createOrg(p);
    await expectCode(svc.list(C.adminCtx()), "MODULE_NOT_ENABLED");
  });
});

describe("Workflow Intelligence — inventory, versions and isolation", () => {
  let id: string;
  it("creates, updates and versions a workflow with audit + events", async () => {
    const w = await svc.create(A.adminCtx(), { name: "Expense approval", department: "Finance", annualVolume: 5000, systems: ["ERP"], riskCategory: "medium" });
    id = w.id;
    expect(w).toMatchObject({ currentVersion: 1, dataClass: "production", source: "manual" });
    const g = await svc.saveGraph(A.adminCtx(), id, { ...graph, changeNote: "Initial model" });
    expect(g.version).toBe(2);
    const u = await svc.update(A.adminCtx(), id, { businessSponsor: "CFO", markReviewed: true });
    expect(u.currentVersion).toBe(3);
    expect(u.lastReviewedAt).not.toBeNull();
    const versions = await svc.listVersions(A.adminCtx(), id);
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(versions.find((v) => v.version === 2)!.stepCount).toBe(4);
    const v1 = await svc.getVersion(A.adminCtx(), id, 1);
    expect((v1.snapshot.steps as unknown[]).length).toBe(0);
    const detail = await svc.get(A.adminCtx(), id);
    expect(detail.steps.map((s) => s.key)).toEqual(["start", "enter", "approve", "done"]);
    expect(detail.edges).toHaveLength(3);

    const audits = await p.db.withSystem("test", (tx) => tx.select().from(auditEvents).where(and(eq(auditEvents.organizationId, A.org.id), eq(auditEvents.resourceId, id))));
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["workflow.created", "workflow.model_saved", "workflow.updated"]));
    const events = await p.db.withSystem("test", (tx) => tx.select().from(eventOutbox).where(and(eq(eventOutbox.organizationId, A.org.id), eq(eventOutbox.type, "workflow.created"))));
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects invalid graphs", async () => {
    await expectCode(svc.saveGraph(A.adminCtx(), id, { steps: graph.steps, edges: [{ from: "start", to: "nope" }] }), "VALIDATION_FAILED");
    await expectCode(svc.saveGraph(A.adminCtx(), id, { steps: [...graph.steps, graph.steps[0]!], edges: [] }), "VALIDATION_FAILED");
  });

  it("ORGANIZATION B can never read or change ORGANIZATION A's workflows", async () => {
    await expectCode(svc.get(B.adminCtx(), id), "NOT_FOUND");
    await expectCode(svc.update(B.adminCtx(), id, { name: "hijack" }), "NOT_FOUND");
    await expectCode(svc.saveGraph(B.adminCtx(), id, graph), "NOT_FOUND");
    await expectCode(svc.analyze(B.adminCtx(), id), "NOT_FOUND");
    await expectCode(svc.remove(B.adminCtx(), id), "NOT_FOUND");
    expect((await svc.list(B.adminCtx())).find((w) => w.id === id)).toBeUndefined();
    expect((await p.search.query(B.adminCtx(), "Expense approval")).hits.find((h) => h.id === id)).toBeUndefined();
    // Even a raw query in B's tenant scope sees nothing (RLS).
    const { wiWorkflows } = await import("../../modules/workflow-intelligence/src/schema");
    const leaked = await p.db.withTenant({ organizationId: B.org.id }, (tx) => tx.select().from(wiWorkflows).where(eq(wiWorkflows.id, id)));
    expect(leaked).toHaveLength(0);
  });

  it("is found by the shared search service in its own org", async () => {
    const r = await p.search.query(A.adminCtx(), "Expense approval");
    expect(r.hits.find((h) => h.id === id)?.url).toBe(`/m/workflow-intelligence/workflows/${id}`);
  });

  it("deletes a workflow", async () => {
    const w = await svc.create(A.adminCtx(), { name: "Temp" });
    await svc.remove(A.adminCtx(), w.id);
    await expectCode(svc.get(A.adminCtx(), w.id), "NOT_FOUND");
  });
});

describe("Workflow Intelligence — RBAC", () => {
  it("enforces permissions server-side and hides financials without workflow.roi.read", async () => {
    const reader = await addMember(p, A.org.id, ["standard_user"]);
    const analyst = await addMember(p, A.org.id, ["analyst"]);
    const w = await svc.create(analyst.ctx(), { name: "Analyst-created", annualVolume: 100 });
    await svc.saveGraph(analyst.ctx(), w.id, graph);
    await svc.setCosts(analyst.ctx(), w.id, [{ category: "implementation", period: "one_time", amount: 1000, provenance: "fact" }]);

    await expectCode(svc.create(reader.ctx(), { name: "nope" }), "FORBIDDEN");
    await expectCode(svc.update(reader.ctx(), w.id, { name: "nope" }), "FORBIDDEN");
    await expectCode(svc.analyze(reader.ctx(), w.id), "FORBIDDEN");
    await expectCode(svc.remove(analyst.ctx(), w.id), "FORBIDDEN");
    await expectCode(svc.setAssumptions(reader.ctx(), w.id, [{ key: "loaded_hourly_rate", value: 80, provenance: "fact" }]), "FORBIDDEN");

    const asReader = await svc.get(reader.ctx(), w.id);
    expect(asReader.canSeeFinancials).toBe(false);
    expect(asReader.roi).toBeNull();
    expect(asReader.costs).toEqual([]);
    const asAnalyst = await svc.get(analyst.ctx(), w.id);
    expect(asAnalyst.roi?.outputs.implementationCost.value).toBe(1000);

    await svc.analyze(analyst.ctx(), w.id);
    const opps = await svc.listOpportunities(reader.ctx());
    expect(opps.find((o) => o.workflowId === w.id)?.estimatedAnnualSavings).toBeNull();
    const dash = await svc.dashboard(reader.ctx());
    expect(dash.totals.estimatedAnnualSavings).toBeNull();
    // Analysts cannot approve opportunities.
    await expectCode(svc.decideOpportunity(analyst.ctx(), opps.find((o) => o.workflowId === w.id)!.id, { decision: "approve" }), "FORBIDDEN");
  });
});

describe("Workflow Intelligence — scoring, ROI, portfolio and implementation", () => {
  it("analyzes, approves with separation of duties, implements and measures realized ROI", async () => {
    const analyst = await addMember(p, A.org.id, ["analyst"]);
    const leader = await addMember(p, A.org.id, ["department_leader"]);
    const w = await svc.create(analyst.ctx(), { name: "Claims intake", department: "Operations", annualVolume: 12_000, systems: ["ERP", "Email"] });
    await svc.saveGraph(analyst.ctx(), w.id, graph);
    await svc.setMetrics(analyst.ctx(), w.id, { employeesInvolved: 4, factors: { repetitiveness: { value: 5, provenance: "fact" }, data_availability: { value: 4, provenance: "fact" }, data_quality: { value: 4, provenance: "assumption" }, integration_availability: { value: 4, provenance: "fact" } } });
    await expectCode(svc.setMetrics(analyst.ctx(), w.id, { factors: { volume: { value: 5, provenance: "fact" } } }), "VALIDATION_FAILED");
    await svc.setAssumptions(analyst.ctx(), w.id, [{ key: "loaded_hourly_rate", value: 50, provenance: "fact", rationale: "HR loaded rate 2026" }]);
    await expectCode(svc.setAssumptions(analyst.ctx(), w.id, [{ key: "adoption_rate", value: 3, provenance: "fact" }]), "VALIDATION_FAILED");
    await svc.setCosts(analyst.ctx(), w.id, [
      { category: "implementation", period: "one_time", amount: 30_000, provenance: "fact" },
      { category: "software", period: "annual", amount: 2_000, provenance: "assumption" },
    ]);

    const a = await svc.analyze(analyst.ctx(), w.id);
    expect(a.scores.scores.aiOpportunity.components.length).toBeGreaterThan(0);
    expect(a.scores.stale).toBe(false);
    expect(a.roi.outputs.roi3yrPct.value).not.toBeNull();
    expect(a.opportunity.status).toBe("identified");
    const detail = await svc.get(analyst.ctx(), w.id);
    expect(detail.assumptions.find((x) => x.key === "loaded_hourly_rate")).toMatchObject({ value: 50, provenance: "fact", defaulted: false });
    expect(detail.assumptions.find((x) => x.key === "adoption_rate")).toMatchObject({ defaulted: true, provenance: "assumption" });

    // Scores become stale when the model changes.
    await svc.update(analyst.ctx(), w.id, { description: "changed" });
    expect((await svc.get(analyst.ctx(), w.id)).scores!.stale).toBe(true);
    const again = await svc.analyze(analyst.ctx(), w.id);
    expect(again.opportunity.id).toBe(a.opportunity.id);

    // Separation of duties: the analyst who created the opportunity cannot approve it (even with the permission).
    const admin = A.adminCtx();
    const own = await svc.create(admin, { name: "Self-approval attempt", annualVolume: 10 });
    const ownA = await svc.analyze(admin, own.id);
    await expectCode(svc.decideOpportunity(admin, ownA.opportunity.id, { decision: "approve" }), "FORBIDDEN");

    const start = await svc.startImplementation(leader.ctx(), a.opportunity.id, { owner: "Ops lead", milestones: [{ name: "Pilot", done: false }] });
    expect(start.stage).toBe("proposed");
    await expectCode(svc.advanceStage(leader.ctx(), start.id, "approved"), "CONFLICT"); // opportunity not approved yet
    const decided = await svc.decideOpportunity(leader.ctx(), a.opportunity.id, { decision: "approve", note: "Go", strategicPriority: 5 });
    expect(decided.status).toBe("approved");
    await svc.advanceStage(leader.ctx(), start.id, "approved");
    await expectCode(svc.advanceStage(leader.ctx(), start.id, "build"), "CONFLICT"); // one step at a time
    for (const s of ["design", "build", "testing", "pilot"] as const) await svc.advanceStage(leader.ctx(), start.id, s);
    await expectCode(svc.advanceStage(leader.ctx(), start.id, "production"), "CONFLICT"); // no baseline yet

    await expectCode(svc.recordBaseline(leader.ctx(), start.id, { periodDays: 30, metrics: { executions: 1000 }, provenance: "fact" }), "FORBIDDEN"); // roi.manage
    await svc.recordBaseline(analyst.ctx(), start.id, { periodDays: 30, metrics: { executions: 1000, labor_hours: 250, operating_cost: 12_500 }, provenance: "fact" });
    await svc.updateImplementation(A.adminCtx(), start.id, { actualCost: 35_000 });
    const prod = await svc.advanceStage(leader.ctx(), start.id, "production");
    expect(prod.deploymentDate).toBeTruthy();
    await expectCode(svc.recordBaseline(analyst.ctx(), start.id, { periodDays: 30, metrics: { executions: 1 }, provenance: "fact" }), "CONFLICT"); // frozen
    await expectCode(svc.advanceStage(leader.ctx(), start.id, "measured"), "CONFLICT"); // no measurement

    const m = await svc.recordMeasurement(analyst.ctx(), start.id, { periodStart: "2026-09-01", periodEnd: "2026-09-30", metrics: { executions: 1000, labor_hours: 100, operating_cost: 5_000 }, provenance: "fact" });
    const savings = m.realized.lines.find((l) => l.key === "annualSavings")!;
    expect(savings.actual).toBeCloseTo(7.5 * 1000 * (365 / 30), 0);
    expect(savings.projected).toBe(again.roi.outputs.annualSavings.value);
    expect(savings.variance).toBeCloseTo(savings.actual! - savings.projected!, 0);
    await svc.advanceStage(leader.ctx(), start.id, "measured");

    const impl = await svc.getImplementation(leader.ctx(), start.id);
    expect(impl.stage).toBe("measured");
    expect(impl.measurements).toHaveLength(1);
    expect(impl.realized?.lines.length).toBe(5);

    const dash = await svc.dashboard(leader.ctx());
    const pva = dash.projectedVsActual.find((x) => x.implementationId === start.id)!;
    expect(pva.actual).toBeCloseTo(savings.actual!, 0);
    expect(dash.totals.realizedRoiPct).not.toBeNull();
    expect(dash.totals.analyzed).toBeGreaterThanOrEqual(2);
    expect(dash.byDepartment.find((d) => d.label === "Operations")).toBeTruthy();

    const types = (await p.db.withSystem("test", (tx) => tx.select({ type: eventOutbox.type }).from(eventOutbox).where(eq(eventOutbox.organizationId, A.org.id)))).map((e) => e.type);
    for (const t of ["workflow.analyzed", "workflow.opportunity.created", "workflow.approved", "workflow.implementation.started", "workflow.production.started", "workflow.roi.measured"]) expect(types).toContain(t);
  });
});

describe("Workflow Intelligence — imports and sample data separation", () => {
  it("imports CSV with per-row errors and idempotent re-import", async () => {
    const csv = "Name,Department,Annual Volume,Systems,Risk\nPayroll changes,HR,2400,Workday; Email,low\n,HR,10,,\nVendor onboarding,Procurement,abc,,\n";
    const r = await svc.importCsv(A.adminCtx(), csv);
    expect(r.created).toBe(1);
    expect(r.errors.map((e) => e.line)).toEqual([3, 4]);
    const again = await svc.importCsv(A.adminCtx(), csv);
    expect(again).toMatchObject({ created: 0, skipped: 1 });
    const w = (await svc.list(A.adminCtx(), { q: "Payroll" }))[0]!;
    expect(w).toMatchObject({ department: "HR", annualVolume: 2400, systems: ["Workday", "Email"], riskCategory: "low", source: "csv" });
  });

  it("imports records through the API path, upserting by external id", async () => {
    const r1 = await svc.importRecords(A.adminCtx(), [{ externalId: "ext-1", name: "Order entry", annualVolume: 9000 }, { name: "" }]);
    expect(r1).toMatchObject({ created: 1 });
    expect(r1.errors).toHaveLength(1);
    const r2 = await svc.importRecords(A.adminCtx(), [{ externalId: "ext-1", name: "Order entry v2" }]);
    expect(r2).toMatchObject({ updated: 1, created: 0 });
    expect((await svc.list(A.adminCtx(), { q: "Order entry v2" }))).toHaveLength(1);
  });

  it("discovers workflows through a shared connector; simulated data lands in the SAMPLE class only", async () => {
    const c = await p.connectors.create(A.adminCtx(), { type: "sandbox", name: "wi-discovery", authType: "none", config: {}, capabilities: ["records.list"] });
    const r = await svc.importFromConnector(A.adminCtx(), { connectorId: c.id, capability: "records.list" });
    expect(r).toMatchObject({ created: 2, simulated: true, dataClass: "sample" });
    const again = await svc.importFromConnector(A.adminCtx(), { connectorId: c.id, capability: "records.list" });
    expect(again).toMatchObject({ created: 0, updated: 2 });
    const prod = await svc.list(A.adminCtx());
    expect(prod.some((w) => w.name.startsWith("Simulated record"))).toBe(false);
    const sample = await svc.list(A.adminCtx(), { dataClass: "sample" });
    expect(sample.filter((w) => w.source === "connector")).toHaveLength(2);
    // Org B cannot use org A's connector.
    await expectCode(svc.importFromConnector(B.adminCtx(), { connectorId: c.id, capability: "records.list" }), "NOT_FOUND");
  });

  it("keeps sample data out of production dashboards", async () => {
    const before = await svc.dashboard(A.adminCtx());
    const { created } = await svc.loadSampleData(A.adminCtx());
    expect(created).toBe(3);
    expect((await svc.loadSampleData(A.adminCtx())).created).toBe(0);
    const sample = await svc.list(A.adminCtx(), { dataClass: "sample" });
    for (const w of sample.filter((x) => x.sourceRef?.startsWith("sample:"))) await svc.analyze(A.adminCtx(), w.id);
    const after = await svc.dashboard(A.adminCtx());
    expect(after.totals.workflows).toBe(before.totals.workflows);
    expect(after.totals.estimatedAnnualSavings).toBe(before.totals.estimatedAnnualSavings);
    const sampleDash = await svc.dashboard(A.adminCtx(), { dataClass: "sample" });
    expect(sampleDash.totals.analyzed).toBe(3);
    expect((await svc.listOpportunities(A.adminCtx())).some((o) => o.dataClass === "sample")).toBe(false);
    const { deleted } = await svc.clearSampleData(A.adminCtx());
    expect(deleted).toBeGreaterThanOrEqual(5);
    expect(await svc.list(A.adminCtx(), { dataClass: "sample" })).toHaveLength(0);
  });
});

describe("Workflow Intelligence — AI redesign through the shared AI layer", () => {
  it("logs the run in ai_runs, links it, and restores the removed human approval", async () => {
    const analyst = await addMember(p, A.org.id, ["analyst"]);
    const w = await svc.create(analyst.ctx(), { name: "Purchase request", annualVolume: 1000 });
    await svc.saveGraph(analyst.ctx(), w.id, graph);
    const rec = await svc.redesign(analyst.ctx(), w.id);

    expect(rec.ai.runId).toBeTruthy();
    expect(rec.promptTemplateId).toBe("workflow.redesign");
    expect(rec.proposal.futureSteps.find((s) => s.key === "approve")).toMatchObject({ type: "approval", requiresApproval: true });
    expect(rec.proposal.restoredControls).toEqual(["approve"]);
    expect(rec.warnings.some((x) => x.includes("Manager approval"))).toBe(true);
    expect(rec.proposal.provenance).toBe("ai_estimate");

    const [run] = await p.db.withTenant({ organizationId: A.org.id }, (tx) => tx.select().from(aiRuns).where(eq(aiRuns.id, rec.ai.runId!)));
    expect(run).toMatchObject({ moduleId: "workflow_intelligence", useCase: "workflow.redesign", promptTemplateId: "workflow.redesign", promptTemplateVersion: "1", actorId: analyst.user.id, organizationId: A.org.id, status: "succeeded" });
    expect(run!.metadata).toMatchObject({ references: { workflowId: w.id } });

    // Reviewing requires workflow.approve.
    await expectCode(svc.reviewRecommendation(analyst.ctx(), rec.id, { decision: "accept" }), "FORBIDDEN");
    const reviewed = await svc.reviewRecommendation(A.adminCtx(), rec.id, { decision: "accept", note: "Pilot it" });
    expect(reviewed.status).toBe("accepted");
    await expectCode(svc.reviewRecommendation(A.adminCtx(), rec.id, { decision: "reject" }), "CONFLICT");
    await expectCode(svc.reviewRecommendation(B.adminCtx(), rec.id, { decision: "reject" }), "NOT_FOUND");
  });

  it("refuses to redesign an empty model", async () => {
    const w = await svc.create(A.adminCtx(), { name: "Empty" });
    await expectCode(svc.redesign(A.adminCtx(), w.id), "VALIDATION_FAILED");
  });
});
