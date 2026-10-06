import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AIProvider } from "../../packages/ai/src";
import { and, auditEvents, eq, eventOutbox, memberships, notifications, sql } from "../../packages/db/src";
import { type TenantContext } from "../../packages/shared-types/src";
import { aiOpsService, type AiOpsService } from "../../modules/ai-operations/src";
import { agentGovernanceService } from "../../modules/agent-governance/src";
import { aiCostRecords, aiOptimizationFindings, aiToolLicenses, aiValueRecords } from "../../modules/ai-operations/src/schema";
import { addMember, createOrg, createTestPlatform, expectCode, systemCtx, uniq } from "../helpers/platform";

type P = Awaited<ReturnType<typeof createTestPlatform>>;
type Org = Awaited<ReturnType<typeof createOrg>>;
type Member = Awaited<ReturnType<typeof addMember>>;

/** Fake "local" provider: answers instantly with fixed token usage so costs are metered. */
const fakeModel: AIProvider = {
  kind: "local",
  async generate(req) {
    return { text: `ok from ${req.model}`, servedModel: req.model, finishReason: "stop", usage: { inputTokens: 400, outputTokens: 100 } };
  },
};

let p: P;
let svc: AiOpsService;
let A: Org;
let B: Org;
let standard: Member;
let analyst: Member;
let reviewer: Member;
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const outbox = (orgId: string, type: string) => p.db.withSystem("test", (tx) => tx.select().from(eventOutbox).where(and(eq(eventOutbox.organizationId, orgId), eq(eventOutbox.type, type))));
const notes = (userId: string, type: string) => p.db.withSystem("test", (tx) => tx.select().from(notifications).where(and(eq(notifications.recipientUserId, userId), eq(notifications.type, type))));
const setDept = (m: Member, d: string) => p.db.withSystem("test", (tx) => tx.update(memberships).set({ department: d }).where(eq(memberships.id, m.membership.id)));
const ai = (ctx: TenantContext, useCase: string, extra: Record<string, unknown> = {}) => p.ai.execute(ctx, { moduleId: "core", useCase, messages: [{ role: "user", content: "Classify this ticket." }], maxTokens: 200, ...extra });

beforeAll(async () => {
  p = await createTestPlatform({ extraAIProviders: [fakeModel] });
  svc = aiOpsService(p);
  A = await createOrg(p);
  B = await createOrg(p);
  for (const o of [A, B]) await p.modules.enable(o.adminCtx(), "ai_operations");
  standard = await addMember(p, A.org.id, ["standard_user"]);
  analyst = await addMember(p, A.org.id, ["analyst"]);
  reviewer = await addMember(p, A.org.id, ["ai_admin"]);
  // Organization-owned models: an economy and a premium model on a (fake) local provider.
  const prov = await p.ai.configureProvider(A.adminCtx(), { key: "acme", name: "Acme models", kind: "local", config: { baseUrl: "http://127.0.0.1:9" } });
  await p.ai.upsertModel(A.adminCtx(), prov.id, { modelKey: "cheap", displayName: "Cheap", tier: "economy", inputCostPerMtok: 0.25, outputCostPerMtok: 1.25, maxDataClassification: "confidential" });
  await p.ai.upsertModel(A.adminCtx(), prov.id, { modelKey: "big", displayName: "Big", tier: "premium", inputCostPerMtok: 15, outputCostPerMtok: 75, maxDataClassification: "restricted", capabilities: ["text", "long_context"] });
});
afterAll(() => p.close());

describe("AI Operations — registration, entitlement and RBAC", () => {
  it("registers permissions, events, notification types, the daily job and the insights of every module", async () => {
    for (const k of ["ai_ops.read", "ai_ops.tool.manage", "ai_ops.vendor.manage", "ai_ops.cost.read", "ai_ops.cost.manage", "ai_ops.adoption.read", "ai_ops.training.manage", "ai_ops.request.manage", "ai_ops.admin"]) {
      expect(p.rbac.registry.get(k)?.owner).toBe("ai_operations");
    }
    for (const t of ["ai_ops.tool.added", "ai_ops.contract.renewal_due", "ai_ops.cost.threshold_exceeded", "ai_ops.request.submitted", "ai_ops.request.approved", "ai_ops.training.required", "ai_ops.optimization.found"]) {
      expect(p.events.registry.get(t)?.owner).toBe("ai_operations");
    }
    expect(p.notificationTypes.get("ai_ops.renewal_due")).toBeTruthy();
    expect(p.jobs.registeredTypes()).toContain("ai_operations.daily");
    const C = await createOrg(p);
    await expectCode(svc.listTools(C.adminCtx()), "MODULE_NOT_ENABLED");
  });

  it("enforces permissions server-side and hides money from people without cost access", async () => {
    await expectCode(svc.addTool(standard.ctx(), { name: "X" }), "FORBIDDEN");
    await expectCode(svc.breakdown(standard.ctx(), {}), "FORBIDDEN");
    await expectCode(svc.adoption(standard.ctx()), "FORBIDDEN");
    await expectCode(svc.addRecords(analyst.ctx(), { periodStart: today(), periodEnd: today(), amountUsd: 1, category: "support" }), "FORBIDDEN");
    await expectCode(svc.savePolicy(analyst.ctx(), null, { name: "p", match: {}, rules: {} }), "FORBIDDEN");
    await svc.addTool(A.adminCtx(), { name: "Copilot Chat", status: "approved", annualCost: 24_000, category: "chat_assistant" });
    expect((await svc.listTools(standard.ctx())).find((t) => t.name === "Copilot Chat")?.annualCost).toBeNull();
    expect((await svc.listTools(analyst.ctx())).find((t) => t.name === "Copilot Chat")?.annualCost).toBe(24_000);
    expect((await svc.breakdown(analyst.ctx(), {})).totals).toBeTruthy();
    const d = await svc.dashboard(standard.ctx());
    expect(d.mode).toBe("personal");
    expect(JSON.stringify(d)).not.toContain("24000");
  });
});

describe("Tools, licenses, vendors and contracts", () => {
  it("inventories tools with licenses and activity; unknown users are reported, not invented", async () => {
    const vendor = await svc.saveVendor(A.adminCtx(), null, { name: uniq("WriteCo"), platformProviderKeys: ["acme"], securityStatus: "approved" });
    const tool = await svc.addTool(A.adminCtx(), { name: uniq("WriterPro"), vendorId: vendor.id, status: "approved", category: "writing_assistant", licensedSeats: 10, annualCost: 12_000, departments: ["Marketing"] });
    expect((await outbox(A.org.id, "ai_ops.tool.added")).some((e) => (e.payload as { toolId: string }).toolId === tool.id)).toBe(true);
    const res = await svc.assignLicenses(A.adminCtx(), tool.id, { users: [standard.user.email, analyst.user.id, reviewer.user.email, "ghost@nowhere.test"] });
    expect(res).toMatchObject({ assigned: 3, unknown: ["ghost@nowhere.test"] });
    await svc.recordActivity(A.adminCtx(), tool.id, { activity: [{ user: standard.user.email, lastActiveAt: new Date().toISOString(), activeDays30: 12 }] });
    const t = await svc.getTool(A.adminCtx(), tool.id);
    expect(t).toMatchObject({ assignedLicenses: 3, activeUsers: 1, unusedLicenses: 2, vendorName: expect.stringContaining("WriteCo") });
    expect(t.licenses).toHaveLength(3);
    expect((await svc.getTool(analyst.ctx(), tool.id)).licenses).toBeNull();
    await expectCode(svc.addTool(A.adminCtx(), { name: tool.name.toUpperCase() }), "CONFLICT");
    const v = await svc.getVendor(analyst.ctx(), vendor.id);
    expect(v.products.map((x) => x.id)).toContain(tool.id);
    expect(v.contacts).toEqual([]);
  });

  it("alerts once per contract renewal inside the notice window", async () => {
    const vendor = await svc.saveVendor(A.adminCtx(), null, { name: uniq("RenewCo") });
    const c = await svc.saveContract(A.adminCtx(), null, { vendorId: vendor.id, name: "RenewCo enterprise", renewalDate: addDays(today(), 30), noticeDays: 30, annualValue: 50_000, ownerUserId: reviewer.user.id });
    await svc.saveContract(A.adminCtx(), null, { vendorId: vendor.id, name: "Far future", renewalDate: addDays(today(), 300), annualValue: 1000 });
    expect(await svc.checkRenewals(A.org.id)).toBe(1);
    expect(await svc.checkRenewals(A.org.id)).toBe(0);
    const ev = (await outbox(A.org.id, "ai_ops.contract.renewal_due")).filter((e) => (e.payload as { contractId: string }).contractId === c.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ daysUntil: 30, annualValue: 50_000 });
    expect((await notes(reviewer.user.id, "ai_ops.renewal_due")).length).toBe(1);
    // A new renewal date re-arms the alert.
    await svc.saveContract(A.adminCtx(), c.id, { renewalDate: addDays(today(), 20) });
    expect(await svc.checkRenewals(A.org.id)).toBe(1);
  });
});

describe("Costs: ledger, allocation, budgets and forecasts", () => {
  let O: Org;
  let finance: Member;
  let ops: Member[];
  beforeAll(async () => {
    O = await createOrg(p);
    await p.modules.enable(O.adminCtx(), "ai_operations");
    finance = await addMember(p, O.org.id, ["analyst"]);
    await setDept(finance, "Finance");
    ops = [];
    for (let i = 0; i < 3; i++) {
      const m = await addMember(p, O.org.id, ["standard_user"]);
      await setDept(m, "Operations");
      ops.push(m);
    }
  });

  it("prorates records by day, dedupes by external reference and adds metered AI cost without copying it", async () => {
    const month = today().slice(0, 7);
    const res = await svc.addRecords(O.adminCtx(), [
      { periodStart: `${month}-01`, periodEnd: addDays(`${month}-01`, 89), amountUsd: 900, category: "subscription", description: "Quarterly seats", externalRef: "INV-1", department: "Finance" },
      { periodStart: `${month}-01`, periodEnd: `${month}-01`, amountUsd: 120, category: "consulting", externalRef: "INV-2" },
    ]);
    expect(res).toEqual({ inserted: 2, duplicates: 0 });
    expect(await svc.addRecords(O.adminCtx(), { periodStart: `${month}-01`, periodEnd: `${month}-01`, amountUsd: 120, category: "consulting", externalRef: "INV-2" })).toEqual({ inserted: 0, duplicates: 1 });
    await p.usage.record(finance.ctx(), { moduleId: "core", metric: "ai.cost", unit: "usd", quantity: 7.5, userId: finance.user.id, aiProvider: "acme", aiModel: "big" });
    const next = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 10);
    const b = await svc.breakdown(O.adminCtx(), { from: `${month}-01`, to: next, by: "category" });
    const days = Math.round((Date.parse(`${next}T00:00:00Z`) - Date.parse(`${month}-01T00:00:00Z`)) / 86_400_000);
    expect(b.rows.find((r) => r.key === "subscription")!.measured).toBeCloseTo((900 * days) / 90, 1);
    expect(b.rows.find((r) => r.key === "inference")!.measured).toBe(7.5);
    const byDept = await svc.breakdown(O.adminCtx(), { from: `${month}-01`, to: next, by: "department" });
    expect(byDept.rows.find((r) => r.key === "Finance")!.measured).toBeCloseTo((900 * days) / 90 + 7.5, 1);
    const byModel = await svc.breakdown(O.adminCtx(), { from: `${month}-01`, to: next, by: "model" });
    expect(byModel.rows.find((r) => r.key === "acme/big")?.measured).toBe(7.5);
    await expectCode(svc.breakdown(finance.ctx(), { by: "user" }), "FORBIDDEN");
  });

  it("estimates contract run-rate only where nothing was recorded against the contract", async () => {
    const vendor = await svc.saveVendor(O.adminCtx(), null, { name: "EstimateCo" });
    const c = await svc.saveContract(O.adminCtx(), null, { vendorId: vendor.id, name: "Seats", annualValue: 36_500, startDate: addDays(today(), -400) });
    const from = addDays(today(), -9);
    const b = await svc.breakdown(O.adminCtx(), { from, to: addDays(today(), 1), by: "basis" });
    expect(b.rows.find((r) => r.key === "estimated")!.estimated).toBeCloseTo(1000, 0);
    await svc.addRecords(O.adminCtx(), { periodStart: from, periodEnd: today(), amountUsd: 800, category: "subscription", contractId: c.id, vendorId: vendor.id });
    const b2 = await svc.breakdown(O.adminCtx(), { from, to: addDays(today(), 1), by: "vendor" });
    expect(b2.rows.find((r) => r.key === vendor.id)).toMatchObject({ estimated: 0, measured: 800, label: "EstimateCo" });
    // Usage-billed contracts are paid through metered usage/invoices: never estimated (no double count).
    const usageVendor = await svc.saveVendor(O.adminCtx(), null, { name: "UsageCo" });
    await svc.saveContract(O.adminCtx(), null, { vendorId: usageVendor.id, name: "API commit", annualValue: 36_500, billingFrequency: "usage", startDate: addDays(today(), -400) });
    // Invoices recorded against the vendor (not the contract) also cover the contract for that month.
    const seatVendor = await svc.saveVendor(O.adminCtx(), null, { name: "SeatCo" });
    await svc.saveContract(O.adminCtx(), null, { vendorId: seatVendor.id, name: "Seats", annualValue: 36_500, startDate: addDays(today(), -400) });
    await svc.addRecords(O.adminCtx(), { periodStart: from, periodEnd: today(), amountUsd: 500, category: "subscription", vendorId: seatVendor.id });
    const b3 = await svc.breakdown(O.adminCtx(), { from, to: addDays(today(), 1), by: "vendor" });
    expect(b3.rows.find((r) => r.key === usageVendor.id)).toBeUndefined();
    expect(b3.rows.find((r) => r.key === seatVendor.id)).toMatchObject({ estimated: 0, measured: 500 });
  });

  it("allocates shared costs to departments exactly, keeps the parent out of totals and can be undone", async () => {
    await svc.addRecords(O.adminCtx(), { periodStart: today(), periodEnd: today(), amountUsd: 100, category: "cloud", description: "Shared GPU", externalRef: "ALLOC-1" });
    const [rec] = await p.db.withSystem("test", (tx) => tx.select().from(aiCostRecords).where(and(eq(aiCostRecords.organizationId, O.org.id), eq(aiCostRecords.externalRef, "ALLOC-1"))));
    const before = (await svc.breakdown(O.adminCtx(), { from: today(), to: addDays(today(), 1), by: "category" })).rows.find((r) => r.key === "cloud")!;
    const res = await svc.allocateRecord(O.adminCtx(), rec!.id, { method: "headcount" });
    // Admin (no department) counts as Unassigned: 1 Finance, 3 Operations, 1 Unassigned.
    expect(res.shares).toEqual({ Finance: 20, Operations: 60, Unassigned: 20 });
    const after = (await svc.breakdown(O.adminCtx(), { from: today(), to: addDays(today(), 1), by: "category" })).rows.find((r) => r.key === "cloud")!;
    expect(after.total).toBe(before.total);
    expect(after).toMatchObject({ allocated: 100, measured: before.measured - 100 });
    await expectCode(svc.allocateRecord(O.adminCtx(), rec!.id, { method: "headcount" }), "CONFLICT");
    await svc.unallocateRecord(O.adminCtx(), rec!.id);
    expect((await svc.breakdown(O.adminCtx(), { from: today(), to: addDays(today(), 1), by: "category" })).rows.find((r) => r.key === "cloud")).toMatchObject({ allocated: 0, measured: before.measured });
    const custom = await svc.allocateRecord(O.adminCtx(), rec!.id, { method: "custom", weights: { Finance: 1, Operations: 2 } });
    expect(custom.shares).toEqual({ Finance: 33.33, Operations: 66.67 });
  });

  it("budget thresholds alert once per period and scope filters apply", async () => {
    const org = await svc.saveBudget(O.adminCtx(), null, { name: "Org monthly", scope: "organization", period: "monthly", amountUsd: 100, thresholds: [50, 100], ownerUserId: finance.user.id });
    expect(org.status).toBe("exceeded");
    const ops = await svc.saveBudget(O.adminCtx(), null, { name: "Ops monthly", scope: "department", scopeValue: "Operations", period: "monthly", amountUsd: 1_000_000 });
    expect(ops.status === "ok" || ops.status === "at_risk").toBe(true);
    expect(ops.spent).toBeLessThan(org.spent);
    await expectCode(svc.saveBudget(O.adminCtx(), null, { name: "No scope", scope: "department", period: "monthly", amountUsd: 5 }), "VALIDATION_FAILED");
    expect(await svc.checkBudgets(O.org.id)).toBe(1);
    expect(await svc.checkBudgets(O.org.id)).toBe(0);
    const ev = (await outbox(O.org.id, "ai_ops.cost.threshold_exceeded")).filter((e) => (e.payload as { budgetId: string }).budgetId === org.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ threshold: 100 });
    expect((await notes(finance.user.id, "ai_ops.budget_threshold")).length).toBe(1);
  });

  it("forecasts the next months from history", async () => {
    const F = await createOrg(p);
    await p.modules.enable(F.adminCtx(), "ai_operations");
    const now = new Date();
    for (let k = 4; k >= 1; k--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1)).toISOString().slice(0, 10);
      await svc.addRecords(F.adminCtx(), { periodStart: d, periodEnd: d, amountUsd: (5 - k) * 100, category: "api" });
    }
    const f = await svc.refreshForecast(F.org.id);
    expect(f.method).toBe("linear_trend");
    expect(f.values).toEqual([500, 600, 700]);
    expect((await svc.listForecasts(F.adminCtx())).map((x) => x.basis)).toEqual(["estimated", "estimated", "estimated"]);
  });
});

describe("AI request workflow", () => {
  it("walks submitted → business → security → technical → financial → approved → implementation → measurement → closed", async () => {
    const r = await svc.submitRequest(standard.ctx(), { kind: "tool", title: "Meeting notes assistant", businessJustification: "Saves time in weekly meetings.", estimatedAnnualCost: 6000, expectedAnnualValue: 20_000, vendorName: "NoteCo" });
    expect(r.stage).toBe("submitted");
    expect((await outbox(A.org.id, "ai_ops.request.submitted")).some((e) => (e.payload as { requestId: string }).requestId === r.id)).toBe(true);
    expect((await notes(reviewer.user.id, "ai_ops.request")).length).toBeGreaterThan(0);
    // Requesters cannot review; non-reviewers cannot act; other people cannot even see it.
    await expectCode(svc.actOnRequest(standard.ctx(), r.id, { action: "start_review" }), "FORBIDDEN");
    await expectCode(svc.getRequest(analyst.ctx(), r.id), "NOT_FOUND");
    await svc.actOnRequest(reviewer.ctx(), r.id, { action: "start_review" });
    await expectCode(svc.actOnRequest(reviewer.ctx(), r.id, { action: "review", decision: "reject" }), "VALIDATION_FAILED");
    await svc.actOnRequest(reviewer.ctx(), r.id, { action: "review", decision: "request_changes", notes: "Add the data involved." });
    expect((await svc.getRequest(standard.ctx(), r.id))).toMatchObject({ stage: "submitted", changesRequested: true });
    await expectCode(svc.actOnRequest(reviewer.ctx(), r.id, { action: "start_review" }), "CONFLICT");
    await svc.updateRequest(standard.ctx(), r.id, { description: "Meeting audio and transcripts (internal)." });
    await svc.actOnRequest(standard.ctx(), r.id, { action: "resubmit", notes: "Added data details." });
    await svc.actOnRequest(reviewer.ctx(), r.id, { action: "start_review" });
    await svc.actOnRequest(reviewer.ctx(), r.id, { action: "review", decision: "approve" });
    await svc.actOnRequest(reviewer.ctx(), r.id, { action: "review", decision: "approve" });
    await svc.actOnRequest(reviewer.ctx(), r.id, { action: "review", decision: "not_applicable", notes: "SaaS; no integration work." });
    const approved = await svc.actOnRequest(reviewer.ctx(), r.id, { action: "review", decision: "approve" });
    expect(approved.stage).toBe("approved");
    expect((await outbox(A.org.id, "ai_ops.request.approved")).some((e) => (e.payload as { requestId: string }).requestId === r.id)).toBe(true);
    expect((await notes(standard.user.id, "ai_ops.request")).some((n) => n.title.includes("approved"))).toBe(true);
    const impl = await svc.actOnRequest(reviewer.ctx(), r.id, { action: "start_implementation" });
    expect(impl.toolId).toBeTruthy();
    const tool = await svc.getTool(A.adminCtx(), impl.toolId!);
    expect(tool).toMatchObject({ source: "request", status: "experimental", requestId: r.id });
    await svc.actOnRequest(reviewer.ctx(), r.id, { action: "start_measurement", outcome: "Pilot with 20 people.", realizedAnnualValue: 15_000 });
    const closed = await svc.actOnRequest(reviewer.ctx(), r.id, { action: "close" });
    expect(closed).toMatchObject({ stage: "closed", closedReason: "completed" });
    const full = await svc.getRequest(standard.ctx(), r.id);
    expect(full.history.map((h) => h.action)).toEqual(["submit", "start_review", "review", "resubmit", "start_review", "review", "review", "review", "review", "start_implementation", "start_measurement", "close"]);
    const value = await p.db.withSystem("test", (tx) => tx.select().from(aiValueRecords).where(eq(aiValueRecords.requestId, r.id)));
    expect(value[0]).toMatchObject({ kind: "realized", basis: "measured", annualValueUsd: 15_000 });
    expect((await p.db.withSystem("test", (tx) => tx.select().from(auditEvents).where(and(eq(auditEvents.organizationId, A.org.id), eq(auditEvents.resourceId, r.id))))).length).toBeGreaterThan(8);
  });

  it("rejection and withdrawal are final; only the requester withdraws", async () => {
    const r = await svc.submitRequest(standard.ctx(), { kind: "agent", title: "Autonomous refund agent" });
    await svc.actOnRequest(reviewer.ctx(), r.id, { action: "start_review" });
    await expectCode(svc.actOnRequest(reviewer.ctx(), r.id, { action: "withdraw" }), "FORBIDDEN");
    await svc.actOnRequest(reviewer.ctx(), r.id, { action: "review", decision: "approve" });
    const rej = await svc.actOnRequest(reviewer.ctx(), r.id, { action: "review", decision: "reject", notes: "Refunds need a human approver." });
    expect(rej.stage).toBe("rejected");
    await expectCode(svc.actOnRequest(standard.ctx(), r.id, { action: "withdraw" }), "CONFLICT");
    const w = await svc.submitRequest(standard.ctx(), { kind: "model", title: "Try a new model" });
    expect((await svc.actOnRequest(standard.ctx(), w.id, { action: "withdraw" })).closedReason).toBe("withdrawn");
    expect((await svc.listRequests(standard.ctx())).every((x) => x.requesterUserId === standard.user.id)).toBe(true);
  });
});

describe("Adoption and training (aggregate, privacy-preserving)", () => {
  let O: Org;
  const sales: Member[] = [];
  let legal: Member[];
  beforeAll(async () => {
    O = await createOrg(p);
    await p.modules.enable(O.adminCtx(), "ai_operations");
    for (let i = 0; i < 6; i++) {
      const m = await addMember(p, O.org.id, ["standard_user"]);
      await setDept(m, "Sales");
      sales.push(m);
    }
    legal = [await addMember(p, O.org.id, ["standard_user"]), await addMember(p, O.org.id, ["standard_user"])];
    for (const m of legal) await setDept(m, "Legal");
    for (const m of sales.slice(0, 3)) await p.usage.record(m.ctx(), { moduleId: "core", metric: "ai.runs", unit: "run", quantity: 4, userId: m.user.id, dimensions: { useCase: "sales.brief" } });
    await p.usage.record(legal[0]!.ctx(), { moduleId: "core", metric: "ai.runs", unit: "run", quantity: 9, userId: legal[0]!.user.id });
  });

  it("reports department adoption and suppresses groups below the minimum size", async () => {
    const a = await svc.adoption(O.adminCtx());
    const s = a.departments.find((d) => d.department === "Sales")!;
    expect(s).toMatchObject({ suppressed: false, members: 6, active: 3, activePct: 50, aiRunsPerActiveUser: 4 });
    expect(a.departments.find((d) => d.department === "Legal")).toMatchObject({ suppressed: true, active: null, members: null });
    expect(JSON.stringify(a)).not.toContain(legal[0]!.user.id);
    expect(JSON.stringify(a)).not.toContain(legal[0]!.user.email);
  });

  it("assigns training by department, records completion against the pass mark and expires it", async () => {
    const prog = await svc.saveProgram(O.adminCtx(), null, { name: "AI for sales research", required: true, passScore: 70, validityDays: 365, workflowFocus: "Account briefs from CRM", departments: ["Sales"] });
    const res = await svc.assignTraining(O.adminCtx(), prog.id, { departments: ["sales"], dueDate: addDays(today(), 14) });
    expect(res.assigned).toBe(6);
    expect((await outbox(O.org.id, "ai_ops.training.required")).filter((e) => (e.payload as { programId: string }).programId === prog.id)).toHaveLength(6);
    expect((await notes(sales[0]!.user.id, "ai_ops.training_required")).length).toBe(1);
    const mine = await svc.listAssignments(sales[0]!.ctx());
    expect(mine).toHaveLength(1);
    await expectCode(svc.completeAssignment(sales[1]!.ctx(), mine[0]!.id, { score: 90 }), "NOT_FOUND");
    await expectCode(svc.completeAssignment(sales[0]!.ctx(), mine[0]!.id, {}), "VALIDATION_FAILED");
    expect(await svc.completeAssignment(sales[0]!.ctx(), mine[0]!.id, { score: 50 })).toMatchObject({ status: "in_progress", passed: false });
    const done = await svc.completeAssignment(sales[0]!.ctx(), mine[0]!.id, { score: 85 });
    expect(done).toMatchObject({ status: "completed", passed: true });
    expect(done.expiresAt).toBeTruthy();
    const a = await svc.adoption(O.adminCtx());
    expect(a.departments.find((d) => d.department === "Sales")!.trainingCompletionPct).toBe(17);
    // Expiry: required training comes back.
    await p.db.withSystem("test", (tx) => tx.execute(sql`update ai_training_assignments set expires_at = now() - interval '1 day' where id = ${mine[0]!.id}`));
    expect(await svc.expireTraining(O.org.id)).toBe(1);
    expect((await svc.listAssignments(sales[0]!.ctx()))[0]).toMatchObject({ status: "assigned", required: true });
  });
});

describe("Model management and routing policies", () => {
  it("advisory policies never change routing; enforced ones do, and nothing qualifying fails closed for that task only", async () => {
    const ctx = reviewer.ctx();
    expect((await ai(ctx, "ticket.classify", { tier: "premium" })).model).toBe("big");
    await svc.savePolicy(A.adminCtx(), null, { name: "Classification is cheap", priority: 10, enforcement: "advisory", match: { useCases: ["*.classify"] }, rules: { allowedTiers: ["economy", "standard"], preferredTier: "economy" } });
    expect((await ai(ctx, "ticket.classify", { tier: "premium" })).model).toBe("big");
    const pol = (await svc.listPolicies(A.adminCtx())).find((x) => x.name === "Classification is cheap")!;
    expect(pol.allowedModels).toContain("acme/cheap");
    expect(pol.allowedModels).not.toContain("acme/big");
    await svc.savePolicy(A.adminCtx(), pol.id, { enforcement: "enforced" });
    expect((await ai(ctx, "ticket.classify", { tier: "premium" })).model).toBe("cheap");
    // Other tasks are untouched.
    expect((await ai(ctx, "contract.review", { tier: "premium" })).model).toBe("big");
    const strict = await svc.savePolicy(A.adminCtx(), null, { name: "Legal on long context, EU only", priority: 5, enforcement: "enforced", match: { useCases: ["legal.*"] }, rules: { allowedProviders: ["eu-provider"] }, regulatoryNote: "EU residency" });
    expect(strict.warning).toMatch(/No enabled model/);
    await expectCode(ai(ctx, "legal.review"), "NOT_CONFIGURED");
    // Organization B is unaffected by A's policies.
    expect((await ai(B.adminCtx(), "legal.review")).model).toBe("sandbox-echo");
    await svc.savePolicy(A.adminCtx(), strict.id, { status: "disabled" });
    expect((await ai(ctx, "legal.review", { tier: "premium" })).model).toBe("big");
  });

  it("reports model spend and policy compliance from the shared run log", async () => {
    const r = await svc.modelReport(A.adminCtx());
    expect(r.models.find((m) => m.model === "acme/big")!.runs).toBeGreaterThan(1);
    const c = r.compliance.find((x) => x.policyName === "Classification is cheap")!;
    expect(c.runs).toBeGreaterThanOrEqual(3);
    expect(c.nonCompliant.some((n) => n.model === "acme/big")).toBe(true);
    expect(c.potentialSavings).toBeGreaterThan(0);
    expect(r.useCases.find((u) => u.useCase === "ticket.classify")?.policy).toBe("Classification is cheap");
  });
});

describe("Cost optimization (recommendations only)", () => {
  it("finds unused licenses, duplicate tools and premium models on simple tasks — and changes nothing", async () => {
    const O = await createOrg(p);
    await p.modules.enable(O.adminCtx(), "ai_operations");
    const u: Member[] = [];
    for (let i = 0; i < 5; i++) u.push(await addMember(p, O.org.id, ["standard_user"]));
    const prov = await p.ai.configureProvider(O.adminCtx(), { key: "acme", name: "Acme models", kind: "local", config: { baseUrl: "http://127.0.0.1:9" } });
    await p.ai.upsertModel(O.adminCtx(), prov.id, { modelKey: "mini", displayName: "Mini", tier: "economy", inputCostPerMtok: 0.1, outputCostPerMtok: 0.4, maxDataClassification: "internal" });
    const t1 = await svc.addTool(O.adminCtx(), { name: "WriterA", category: "writing_assistant", status: "approved", licensedSeats: 5, annualCost: 5000, departments: ["Marketing"] });
    await svc.addTool(O.adminCtx(), { name: "WriterB", category: "writing_assistant", status: "experimental", licensedSeats: 5, annualCost: 2000, departments: ["Marketing"] });
    await svc.assignLicenses(O.adminCtx(), t1.id, { users: u.map((m) => m.user.email) });
    await svc.recordActivity(O.adminCtx(), t1.id, { activity: [{ user: u[0]!.user.email, lastActiveAt: new Date().toISOString() }] });
    // Premium model used for many tiny requests (written to the shared run log as the AI layer would).
    for (let i = 0; i < 60; i++) {
      await p.db.withSystem("test", (tx) => tx.execute(sql`insert into ai_runs (organization_id, provider_key, model_key, module_id, use_case, actor_type, actor_id, status, input_tokens, output_tokens, latency_ms, estimated_cost_usd, prompt_retention, metadata)
        values (${O.org.id}, 'anthropic', 'claude-opus-5-5', 'core', 'email.tag', 'user', ${u[1]!.user.id}, 'succeeded', 300, 20, 900, 0.006, 'metadata', '{"dataClassification":"internal"}'::jsonb)`));
    }
    const res = await svc.runScan(O.adminCtx());
    expect(res.created).toBeGreaterThanOrEqual(2);
    const f = await svc.listFindings(O.adminCtx());
    const unused = f.find((x) => x.kind === "unused_licenses")!;
    expect(unused).toMatchObject({ toolId: t1.id, estimatedAnnualSavings: 4000, basis: "estimated" });
    expect(f.find((x) => x.kind === "duplicate_tools")!.estimatedAnnualSavings).toBe(2000);
    const model = f.find((x) => x.kind === "expensive_model")!;
    expect(model).toMatchObject({ modelKey: "anthropic/claude-opus-5-5" });
    expect(model.evidence).toMatchObject({ alternative: "acme/mini", runs: 60 });
    expect(model.recommendation).toMatch(/Nothing is switched automatically/);
    expect((await outbox(O.org.id, "ai_ops.optimization.found")).length).toBe(res.created);
    // Re-scanning updates rather than duplicates.
    expect((await svc.runScan(O.adminCtx())).created).toBe(0);
    // Nothing was changed automatically.
    const lic = await p.db.withSystem("test", (tx) => tx.select().from(aiToolLicenses).where(eq(aiToolLicenses.toolId, t1.id)));
    expect(lic.every((l) => l.status === "active")).toBe(true);
    expect((await svc.getTool(O.adminCtx(), t1.id)).status).toBe("approved");
    await svc.decideFinding(O.adminCtx(), unused.id, { status: "accepted", note: "Reclaim at true-up" });
    await expectCode(svc.decideFinding(analyst.ctx(), unused.id, { status: "dismissed" }), "FORBIDDEN");
    await expectCode(svc.decideFinding(A.adminCtx(), unused.id, { status: "dismissed" }), "NOT_FOUND");
    // Fixed: once the licenses are revoked the finding resolves itself on the next scan.
    await p.db.withSystem("test", (tx) => tx.update(aiToolLicenses).set({ status: "revoked" }).where(and(eq(aiToolLicenses.toolId, t1.id), sql`last_active_at is null`)));
    await svc.runScan(O.adminCtx());
    const after = await p.db.withSystem("test", (tx) => tx.select().from(aiOptimizationFindings).where(eq(aiOptimizationFindings.id, unused.id)));
    expect(after[0]!.status).toBe("resolved");
  });
});

describe("Cross-module analytics and the executive dashboard", () => {
  it("aggregates other modules through their insight read models and the event stream, without touching their tables", async () => {
    for (const m of ["workflow_intelligence", "agent_governance", "integration_hub", "data_security", "knowledge_verification"]) await p.modules.enable(A.adminCtx(), m);
    await agentGovernanceService(p).registerAgent(A.adminCtx(), { name: uniq("Support triage agent") });
    const implementationId = randomUUID();
    await p.events.bus.publish(A.adminCtx(), "workflow.roi.measured", { implementationId, workflowId: randomUUID(), measurementId: randomUUID(), actualAnnualSavings: 42_000, dataClass: "production" });
    await p.events.bus.publish(A.adminCtx(), "workflow.roi.measured", { implementationId, workflowId: randomUUID(), measurementId: randomUUID(), actualAnnualSavings: 48_000, dataClass: "production" });
    for (let i = 0; i < 5; i++) await p.events.bus.dispatchPending(200);
    const v = await p.db.withSystem("test", (tx) => tx.select().from(aiValueRecords).where(and(eq(aiValueRecords.organizationId, A.org.id), eq(aiValueRecords.sourceRef, implementationId))));
    expect(v).toHaveLength(1);
    expect(v[0]!.annualValueUsd).toBe(48_000);

    const d = await svc.dashboard(A.adminCtx());
    if (d.mode !== "executive") throw new Error("expected executive dashboard");
    expect(d.modules.map((m) => m.moduleId).sort()).toEqual(["agent_governance", "data_security", "integration_hub", "knowledge_verification", "workflow_intelligence"]);
    expect(d.agents.total).toBe(1);
    expect(d.value.realized).toBeGreaterThanOrEqual(48_000 + 15_000);
    expect(d.value.basisRealized).toBe("measured");
    expect(d.requests.pending).toBeGreaterThanOrEqual(0);
    expect(d.spend.total).toBeGreaterThan(0);
    expect(d.modelSpend.rows.find((r) => r.key === "acme/big")).toBeTruthy();
    expect(d.governance.signals.some((s) => s.key === "security.open_incidents")).toBe(true);
    const ue = d.unitEconomics.metrics.find((m) => m.key === "per_value_dollar")!;
    expect(ue.perUnit).not.toBeNull();
    expect(d.unitEconomics.metrics.every((m) => m.cost.measured >= 0 && m.cost.estimated >= 0 && m.cost.allocated >= 0)).toBe(true);
    // A module that is disabled disappears from the aggregation.
    await p.modules.disable(A.adminCtx(), "data_security");
    expect((await p.insights.collect(A.adminCtx())).map((m) => m.moduleId)).not.toContain("data_security");
  });
});

describe("Tenant isolation", () => {
  it("organization B can never see or change organization A's AI estate", async () => {
    const tool = (await svc.listTools(A.adminCtx()))[0]!;
    const vendor = (await svc.listVendors(A.adminCtx()))[0]!;
    const req = (await svc.listRequests(A.adminCtx()))[0]!;
    await expectCode(svc.getTool(B.adminCtx(), tool.id), "NOT_FOUND");
    await expectCode(svc.getVendor(B.adminCtx(), vendor.id), "NOT_FOUND");
    await expectCode(svc.getRequest(B.adminCtx(), req.id), "NOT_FOUND");
    await expectCode(svc.updateTool(B.adminCtx(), tool.id, { status: "retiring" }), "NOT_FOUND");
    await expectCode(svc.assignLicenses(B.adminCtx(), tool.id, { users: [B.admin.email] }), "NOT_FOUND");
    expect(await svc.listTools(B.adminCtx())).toHaveLength(0);
    expect((await svc.breakdown(B.adminCtx(), {})).totals.total).toBeLessThan((await svc.breakdown(A.adminCtx(), {})).totals.total);
    expect((await svc.breakdown(B.adminCtx(), { by: "model" })).rows.some((r) => r.key.startsWith("acme/"))).toBe(false);
    // System context of B cannot read A either.
    await expectCode(svc.getTool(systemCtx(B.org.id), tool.id), "NOT_FOUND");
  });
});
