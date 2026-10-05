import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AIProvider } from "../../packages/ai/src";
import { aiRuns, and, auditEvents, eq, eventOutbox, sql } from "../../packages/db/src";
import { integrationService, type IntegrationService } from "../../modules/integration-hub/src";
import { integrationErrors, integrationExecutions } from "../../modules/integration-hub/src/schema";
import { addMember, createOrg, createTestPlatform, expectCode, uniq } from "../helpers/platform";

type P = Awaited<ReturnType<typeof createTestPlatform>>;

/** Replaces the simulated provider: answers AI steps with structured JSON. */
const quoteModel: AIProvider = {
  kind: "sandbox",
  async generate(req) {
    return { text: JSON.stringify({ sku: "SKU-9", quantity: 200, urgency: "high" }), servedModel: req.model, finishReason: "stop", usage: { inputTokens: 50, outputTokens: 20 } };
  },
};

let p: P;
let svc: IntegrationService;
let A: Awaited<ReturnType<typeof createOrg>>;
let B: Awaited<ReturnType<typeof createOrg>>;
let sandboxId: string;

/** Make scheduled integration jobs due and run the queue until idle. */
async function drain() {
  for (let i = 0; i < 20; i++) {
    await p.db.withSystem("test.jobs_due", (tx) => tx.execute(sql`update background_jobs_metadata set run_at = now() where status in ('queued','failed') and type like 'integration.%'`));
    if ((await p.jobs.runOnce("test", { batch: 50 })) === 0) return;
  }
}

async function setupOrg(o: Awaited<ReturnType<typeof createOrg>>) {
  await p.modules.enable(o.adminCtx(), "integration_hub");
  const c = await p.connectors.create(o.adminCtx(), { type: "sandbox", name: uniq("sbx"), authType: "none", config: {} });
  return c.id;
}

beforeAll(async () => {
  p = await createTestPlatform({ extraAIProviders: [quoteModel] });
  svc = integrationService(p);
  A = await createOrg(p);
  B = await createOrg(p);
  sandboxId = await setupOrg(A);
  await setupOrg(B);
  const install = (templateKey: string, key: string, extra: Record<string, unknown> = {}) => svc.installTemplate(A.adminCtx(), { templateKey, connectorId: sandboxId, key, aiExposed: true, ...extra });
  await install("sandbox.list_records", "crm.lookup");
  await install("sandbox.create_record", "crm.write", { retry: { maxAttempts: 2, backoffSeconds: 1 } });
  await install("sandbox.create_record", "crm.write_approved", { requiresApproval: true });
  await install("sandbox.simulate_failure", "test.fail", { retry: { maxAttempts: 2, backoffSeconds: 1 } });
});
afterAll(() => p.close());

describe("Integration — registration and entitlement", () => {
  it("registers permissions, events, notification types and a policy kind in the shared registries", () => {
    expect(p.rbac.registry.get("integration.admin")?.owner).toBe("integration_hub");
    for (const t of ["integration.workflow.created", "integration.execution.started", "integration.execution.failed", "integration.execution.completed", "integration.approval.required", "integration.action.executed"]) {
      expect(p.events.registry.get(t)?.owner).toBe("integration_hub");
    }
    expect(p.policies.kinds().find((k) => k.key === "integration_action")?.owner).toBe("integration_hub");
    expect(p.jobs.registeredTypes()).toEqual(expect.arrayContaining(["integration.execution.run", "integration.approval.expire"]));
  });
  it("is unusable until enabled", async () => {
    const C = await createOrg(p);
    await expectCode(svc.listActions(C.adminCtx()), "MODULE_NOT_ENABLED");
  });
});

describe("Integration — action catalog and schema validation", () => {
  it("lists templates with the org's matching connectors", async () => {
    const t = await svc.templates(A.adminCtx());
    expect(t.find((x) => x.key === "sandbox.create_record")?.connectors.map((c) => c.id)).toContain(sandboxId);
    expect(t.find((x) => x.key === "salesforce.create_lead")?.availability).toBe("contract_only");
  });
  it("binds templates only to a connector of the right type, never laxer than the template", async () => {
    await expectCode(svc.installTemplate(A.adminCtx(), { templateKey: "salesforce.create_lead", connectorId: sandboxId }), "VALIDATION_FAILED");
    const a = await svc.installTemplate(A.adminCtx(), { templateKey: "sandbox.create_record", connectorId: sandboxId, key: "crm.write_low", risk: "low" });
    expect(a.risk).toBe("medium");
    await expectCode(svc.installTemplate(A.adminCtx(), { templateKey: "sandbox.create_record", connectorId: sandboxId, key: "crm.write_low" }), "CONFLICT");
  });
  it("custom actions need integration.admin and a REST connector; UI automation is forced to high risk + approval", async () => {
    const analyst = await addMember(p, A.org.id, ["analyst"]);
    const rest = await p.connectors.create(A.adminCtx(), { type: "rest_api", name: uniq("rest"), authType: "none", config: { baseUrl: "https://api.example.com" } });
    const base = { key: "erp.ui_submit", name: "Submit via UI bot", connectorId: rest.id, method: "POST", path: "/bots/{{input.bot}}/run", inputSchema: { type: "object", required: ["bot"], properties: { bot: { type: "string", maxLength: 40 } } } };
    await expectCode(svc.createCustomAction(analyst.ctx(), base), "FORBIDDEN");
    await expectCode(svc.createCustomAction(A.adminCtx(), { ...base, connectorId: sandboxId }), "VALIDATION_FAILED");
    await expectCode(svc.createCustomAction(A.adminCtx(), { ...base, headers: { Authorization: "Bearer stolen" } }), "VALIDATION_FAILED");
    const ui = await svc.createCustomAction(A.adminCtx(), { ...base, bridgeType: "ui_automation", risk: "low", requiresApproval: false, capturePayloads: false });
    expect(ui).toMatchObject({ risk: "high", requiresApproval: true, capturePayloads: true, operation: "write", kind: "custom" });
    await expectCode(svc.updateAction(A.adminCtx(), ui.id, { requiresApproval: false }), "VALIDATION_FAILED");
    await expectCode(svc.createCustomAction(A.adminCtx(), { ...base, key: "bad.schema", inputSchema: { type: "object", required: ["x"], properties: {} } }), "VALIDATION_FAILED");
  });
  it("gateway rejects invalid parameters, unknown and unexposed tools", async () => {
    await expectCode(svc.invokeTool(A.adminCtx(), "crm.write", { input: { name: "" } }), "VALIDATION_FAILED");
    await expectCode(svc.invokeTool(A.adminCtx(), "crm.write", { input: { name: "x", unexpected: true } }), "VALIDATION_FAILED");
    await expectCode(svc.invokeTool(A.adminCtx(), "no.such.tool", { input: {} }), "NOT_FOUND");
    await expectCode(svc.invokeTool(A.adminCtx(), "crm.write_low", { input: { name: "x" } }), "NOT_FOUND"); // not AI-exposed
  });
  it("tool list exposes JSON schemas only for AI-exposed actions", async () => {
    const tools = await svc.listTools(A.adminCtx());
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["crm.lookup", "crm.write"]));
    expect(tools.find((t) => t.name === "crm.write_low")).toBeUndefined();
    expect(tools.find((t) => t.name === "crm.write")?.input_schema).toMatchObject({ type: "object", required: ["name"] });
  });
});

describe("Integration — authorization, policy and approvals", () => {
  it("enforces permissions server-side", async () => {
    const reader = await addMember(p, A.org.id, ["standard_user"]);
    await expectCode(svc.invokeTool(reader.ctx(), "crm.lookup", { input: {} }), "FORBIDDEN");
    await expectCode(svc.listExecutions(reader.ctx()), "FORBIDDEN");
    await expectCode(svc.createWorkflow(reader.ctx(), { name: "x" }), "FORBIDDEN");
    expect((await svc.listActions(reader.ctx())).length).toBeGreaterThan(0);
  });

  it("runs an AI tool call end to end with logging and events", async () => {
    const analyst = await addMember(p, A.org.id, ["analyst"]);
    const r = await svc.invokeTool(analyst.ctx(), "crm.write", { input: { name: "Acme lead", amount: 42 }, agent: { id: "agent-7", name: "Quote bot" } });
    expect(r.status).toBe("succeeded");
    expect(r.output).toMatchObject({ simulated: true, record: { name: "Acme lead", amount: 42 } });
    const d = await svc.getExecution(A.adminCtx(), r.executionId);
    expect(d).toMatchObject({ trigger: "gateway", actionKey: "crm.write", systemCalls: 1, agent: { id: "agent-7", verified: false } });
    expect(d.steps.map((s) => `${s.nodeKey}:${s.status}`)).toEqual(["start:succeeded", "action:succeeded", "done:succeeded"]);
    expect(d.steps[1]!.systemCall).toMatchObject({ connectorId: sandboxId, capability: "records.write", operation: "write" });
    expect(d.steps[1]!.policyDecision).toMatchObject({ effect: "ALLOW" });
    const types = (await p.db.withSystem("test", (tx) => tx.select({ type: eventOutbox.type }).from(eventOutbox).where(eq(eventOutbox.organizationId, A.org.id)))).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["integration.execution.started", "integration.action.executed", "integration.execution.completed"]));
    const audits = await p.db.withSystem("test", (tx) => tx.select({ action: auditEvents.action }).from(auditEvents).where(and(eq(auditEvents.organizationId, A.org.id), eq(auditEvents.resourceId, r.executionId))));
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["integration.execution_requested", "integration.execution_succeeded"]));
  });

  it("idempotency: the same key never sends a write twice", async () => {
    const first = await svc.invokeTool(A.adminCtx(), "crm.write", { input: { name: "Once" }, idempotencyKey: "idem-key-0001" });
    const second = await svc.invokeTool(A.adminCtx(), "crm.write", { input: { name: "Once" }, idempotencyKey: "idem-key-0001" });
    expect(second).toMatchObject({ executionId: first.executionId, duplicate: true });
    const list = await svc.invokeTool(A.adminCtx(), "crm.lookup", { input: {} });
    expect(((list.output as { records: Array<{ name: string }> }).records).filter((r) => r.name === "Once")).toHaveLength(1);
  });

  it("blocks on approval, enforces separation of duties, then runs once approved", async () => {
    const approver = await addMember(p, A.org.id, ["department_leader"]);
    const r = await svc.invokeTool(A.adminCtx(), "crm.write_approved", { input: { name: "Big deal", amount: 50000 } });
    expect(r.status).toBe("waiting_approval");
    expect(r.approvalId).toBeTruthy();
    const pending = await svc.getExecution(A.adminCtx(), r.executionId);
    expect(pending.systemCalls).toBe(0);
    expect(pending.approvals[0]).toMatchObject({ status: "pending", risk: "medium", proposedPayload: { name: "Big deal", amount: 50000 } });
    expect(pending.approvals[0]!.system).toContain("sandbox");
    await expectCode(svc.decideApproval(A.adminCtx(), r.approvalId!, { decision: "approve" }), "FORBIDDEN"); // initiator
    const decided = await svc.decideApproval(approver.ctx(), r.approvalId!, { decision: "approve", note: "ok" }, { wait: true });
    expect(decided.status).toBe("approved");
    const done = await svc.getExecution(A.adminCtx(), r.executionId);
    expect(done.status).toBe("succeeded");
    expect(done.systemCalls).toBe(1);
    await expectCode(svc.decideApproval(approver.ctx(), r.approvalId!, { decision: "reject" }), "CONFLICT");
  });

  it("a rejected approval fails the call without touching the system", async () => {
    const approver = await addMember(p, A.org.id, ["department_leader"]);
    const r = await svc.invokeTool(A.adminCtx(), "crm.write_approved", { input: { name: "No go" } });
    await svc.decideApproval(approver.ctx(), r.approvalId!, { decision: "reject", note: "too risky" }, { wait: true });
    const d = await svc.getExecution(A.adminCtx(), r.executionId);
    expect(d).toMatchObject({ status: "failed", errorClass: "approval_rejected", systemCalls: 0 });
  });

  it("shared policies can deny or require approval for any action", async () => {
    await p.policies.create(A.adminCtx(), {
      key: "integration.guard", name: "Integration guard", kind: "integration_action",
      definition: { combining: "deny-overrides", defaultEffect: "ALLOW", rules: [
        { id: "deny-fail", effect: "DENY", description: "No failure simulation", when: { field: "resource.id", op: "eq", value: "test.fail" } },
        { id: "big-needs-approval", effect: "REQUIRE_APPROVAL", description: "Large amounts", when: { field: "context.input.amount", op: "gt", value: 100000 } },
      ] },
    });
    await p.policies.activate(A.adminCtx(), "integration.guard", 1);
    const denied = await svc.invokeTool(A.adminCtx(), "test.fail", { input: { kind: "transient" } });
    expect(denied).toMatchObject({ status: "failed", error: { class: "policy_denied" } });
    const big = await svc.invokeTool(A.adminCtx(), "crm.write", { input: { name: "Huge", amount: 250000 } });
    expect(big.status).toBe("waiting_approval");
    const small = await svc.invokeTool(A.adminCtx(), "crm.write", { input: { name: "Small", amount: 10 } });
    expect(small.status).toBe("succeeded");
    await p.policies.disable(A.adminCtx(), "integration.guard");
  });
});

describe("Integration — reliability", () => {
  async function workflow(nodes: unknown[], edges: unknown[]) {
    const w = await svc.createWorkflow(A.adminCtx(), { name: uniq("wf") });
    const g = await svc.saveGraph(A.adminCtx(), w.id, { nodes, edges });
    expect(g.issues).toEqual([]);
    await svc.publishWorkflow(A.adminCtx(), w.id);
    return w;
  }
  const node = (key: string, type: string, config: Record<string, unknown> = {}) => ({ key, type, name: key, config });

  it("retries transient failures with backoff, then dead-letters them", async () => {
    const w = await workflow([node("start", "trigger"), node("boom", "connector_action", { actionKey: "test.fail", input: { kind: "transient" } }), node("done", "completion", { output: {} })], [{ from: "start", to: "boom" }, { from: "boom", to: "done" }]);
    const first = await svc.startExecution(A.adminCtx(), w.id, { wait: true });
    expect(first.status).toBe("waiting_delay");
    expect(first.errorMessage).toMatch(/retrying in/);
    await drain();
    const after = await svc.getExecution(A.adminCtx(), first.id);
    expect(after.status).toBe("failed");
    expect(after.errorClass).toBe("transient");
    expect(after.steps.filter((s) => s.nodeKey === "boom").map((s) => s.attempt)).toEqual([1, 2]);
    expect(after.errors.map((e) => e.status)).toContain("dead_letter");
    expect((await svc.listErrors(A.adminCtx(), { status: "dead_letter" })).some((e) => e.executionId === first.id)).toBe(true);
  });

  it("permanent errors are not retried; an error edge routes to the exception handler; prior writes make it a partial failure", async () => {
    const w = await workflow(
      [
        node("start", "trigger"),
        node("write", "connector_action", { actionKey: "crm.write", input: { name: "partial" } }),
        node("boom", "connector_action", { actionKey: "test.fail", input: { kind: "permanent" } }),
        node("handler", "exception_handler", { compensate: true }),
        node("done", "completion", { output: {} }),
      ],
      [{ from: "start", to: "write" }, { from: "write", to: "boom" }, { from: "boom", to: "done" }, { from: "boom", to: "handler", kind: "error" }],
    );
    const r = await svc.startExecution(A.adminCtx(), w.id, { wait: true });
    expect(r.status).toBe("partially_failed");
    expect(r.steps.filter((s) => s.nodeKey === "boom")).toHaveLength(1);
    const handler = r.steps.find((s) => s.nodeKey === "handler")!;
    expect(handler.output).toMatchObject({ compensation: [{ nodeKey: "write", status: "not_reversible" }] });
    // Retry resumes from the failed step; the completed write is not repeated.
    const retried = await svc.retryExecution(A.adminCtx(), r.id, { wait: true });
    expect(retried.steps.filter((s) => s.nodeKey === "write" && s.status === "succeeded")).toHaveLength(1);
  });

  it("opens the circuit for a connector after repeated transient failures", async () => {
    const [anyEx] = await p.db.withTenant({ organizationId: A.org.id }, (tx) => tx.select({ id: integrationExecutions.id }).from(integrationExecutions).limit(1));
    await p.db.withTenant({ organizationId: A.org.id }, (tx) =>
      tx.insert(integrationErrors).values(Array.from({ length: 5 }, () => ({ organizationId: A.org.id, executionId: anyEx!.id, connectorId: sandboxId, errorClass: "transient", message: "x", retryable: true }))),
    );
    const r = await svc.invokeTool(A.adminCtx(), "crm.lookup", { input: {} });
    expect(r.status).toBe("waiting_delay");
    const d = await svc.getExecution(A.adminCtx(), r.executionId);
    expect(d.steps.find((s) => s.nodeKey === "action")?.errorClass).toBe("circuit_open");
    expect((await svc.overview(A.adminCtx())).breakers.find((b) => b.connectorId === sandboxId)?.state).toBe("open");
    await p.db.withTenant({ organizationId: A.org.id }, (tx) => tx.delete(integrationErrors).where(eq(integrationErrors.connectorId, sandboxId)));
    await svc.cancelExecution(A.adminCtx(), r.executionId);
  });

  it("validates conditions with the shared policy engine and maps data between steps", async () => {
    const w = await workflow(
      [
        node("start", "trigger"),
        node("shape", "transform", { mappings: [{ target: "name", source: "input.customer", transforms: ["trim", "uppercase"], required: true }, { target: "amount", compute: { op: "multiply", args: ["input.qty", 10] }, type: "number" }] }),
        node("big", "condition", { condition: { field: "context.steps.shape.amount", op: "gte", value: 100 } }),
        node("save", "connector_action", { actionKey: "crm.write", input: { name: "{{steps.shape.name}}", amount: "{{steps.shape.amount}}" } }),
        node("big_done", "completion", { output: { saved: "{{steps.save.record.name}}" } }),
        node("small_done", "completion", { output: { skipped: true } }),
      ],
      [{ from: "start", to: "shape" }, { from: "shape", to: "big" }, { from: "big", to: "save", kind: "true" }, { from: "big", to: "small_done", kind: "false" }, { from: "save", to: "big_done" }],
    );
    expect((await svc.startExecution(A.adminCtx(), w.id, { input: { customer: " acme ", qty: 12 }, wait: true })).output).toEqual({ saved: "ACME" });
    expect((await svc.startExecution(A.adminCtx(), w.id, { input: { customer: "tiny", qty: 1 }, wait: true })).output).toEqual({ skipped: true });
    const bad = await svc.startExecution(A.adminCtx(), w.id, { input: { qty: 1 }, wait: true });
    expect(bad).toMatchObject({ status: "failed", errorClass: "validation" });
  });

  it("refuses to publish an invalid graph and to run drafts live", async () => {
    const w = await svc.createWorkflow(A.adminCtx(), { name: uniq("draft") });
    await svc.saveGraph(A.adminCtx(), w.id, { nodes: [node("start", "trigger"), node("x", "connector_action", { actionKey: "nope" }), node("done", "completion")], edges: [{ from: "start", to: "x" }, { from: "x", to: "done" }] });
    await expectCode(svc.publishWorkflow(A.adminCtx(), w.id), "VALIDATION_FAILED");
    await expectCode(svc.startExecution(A.adminCtx(), w.id, {}), "CONFLICT");
  });
});

describe("Integration — sample workflow (customer quote) end to end", () => {
  it("test mode runs against the sandbox and auto-skips approvals; live mode pauses for the manager", async () => {
    const C = await createOrg(p);
    await p.modules.enable(C.adminCtx(), "integration_hub");
    const sample = await svc.createSample(C.adminCtx());
    expect(sample.issues).toEqual([]);
    const test = await svc.startExecution(C.adminCtx(), sample.id, { mode: "test", input: { customerEmail: "Buyer@Example.com", request: "Need 200 units of SKU-9 urgently" } });
    expect(test.status).toBe("succeeded");
    expect(test.steps.find((s) => s.nodeKey === "manager_approval")?.status).toBe("skipped");
    expect(test.output).toMatchObject({ status: "quoted" });

    await svc.publishWorkflow(C.adminCtx(), sample.id);
    const live = await svc.startExecution(C.adminCtx(), sample.id, { input: { customerEmail: "buyer@example.com", request: "Need 200 units of SKU-9 urgently" }, wait: true });
    expect(live.status).toBe("waiting_approval");
    const ai = live.steps.find((s) => s.nodeKey === "interpret")!;
    expect(ai.aiRunId).toBeTruthy();
    const [run] = await p.db.withTenant({ organizationId: C.org.id }, (tx) => tx.select().from(aiRuns).where(eq(aiRuns.id, ai.aiRunId!)));
    expect(run).toMatchObject({ moduleId: "integration_hub", useCase: "integration.ai_step", status: "succeeded" });
    expect(live.steps.find((s) => s.nodeKey === "pricing")?.output).toMatchObject({ subtotal: 19000, quantity: 200, customerEmail: "buyer@example.com" });

    const manager = await addMember(p, C.org.id, ["department_leader"]);
    await svc.decideApproval(manager.ctx(), live.approvals[0]!.id, { decision: "approve" }, { wait: true });
    const done = await svc.getExecution(C.adminCtx(), live.id);
    expect(done.status).toBe("succeeded");
    expect(done.output).toMatchObject({ status: "quoted", subtotal: 19000 });
    expect(done.systemCalls).toBe(4);
  });

  it("event triggers start the workflow once per event, as the publisher", async () => {
    const w = await svc.createWorkflow(A.adminCtx(), { name: uniq("on-policy"), triggerType: "event", triggerConfig: { eventType: "policy.activated" } });
    await svc.saveGraph(A.adminCtx(), w.id, { nodes: [node("start", "trigger"), node("done", "completion", { output: { key: "{{input.event.payload.key}}" } })], edges: [{ from: "start", to: "done" }] });
    await svc.publishWorkflow(A.adminCtx(), w.id);
    await expectCode(svc.createWorkflow(A.adminCtx(), { name: "loop", triggerType: "event", triggerConfig: { eventType: "integration.execution.completed" } }), "VALIDATION_FAILED");
    const event = { id: crypto.randomUUID(), type: "policy.activated", organizationId: A.org.id, payload: { key: "k1" }, occurredAt: new Date().toISOString() };
    await svc.onEvent(event);
    await svc.onEvent(event);
    await drain();
    const runs = await svc.listExecutions(A.adminCtx(), { workflowId: w.id });
    expect(runs.data).toHaveLength(1);
    expect(runs.data[0]).toMatchObject({ trigger: "event", status: "succeeded", actor: { id: A.admin.id } });
  });

  function node(key: string, type: string, config: Record<string, unknown> = {}) {
    return { key, type, name: key, config };
  }
});

describe("Integration — tenant isolation", () => {
  it("ORGANIZATION B can never see or use ORGANIZATION A's integrations", async () => {
    const r = await svc.invokeTool(A.adminCtx(), "crm.write_approved", { input: { name: "A secret" } });
    const [aAction] = await svc.listActions(A.adminCtx(), { q: "crm.lookup" });
    const aWf = (await svc.listWorkflows(A.adminCtx()))[0]!;
    await expectCode(svc.getExecution(B.adminCtx(), r.executionId), "NOT_FOUND");
    await expectCode(svc.getAction(B.adminCtx(), aAction!.id), "NOT_FOUND");
    await expectCode(svc.getWorkflow(B.adminCtx(), aWf.id), "NOT_FOUND");
    await expectCode(svc.startExecution(B.adminCtx(), aWf.id, { mode: "test" }), "NOT_FOUND");
    await expectCode(svc.decideApproval(B.adminCtx(), r.approvalId!, { decision: "approve" }), "NOT_FOUND");
    await expectCode(svc.cancelExecution(B.adminCtx(), r.executionId), "NOT_FOUND");
    await expectCode(svc.invokeTool(B.adminCtx(), "crm.lookup", { input: {} }), "NOT_FOUND");
    await expectCode(svc.installTemplate(B.adminCtx(), { templateKey: "sandbox.list_records", connectorId: sandboxId, key: "steal.it" }), "NOT_FOUND");
    expect((await svc.listApprovals(B.adminCtx())).some((a) => a.id === r.approvalId)).toBe(false);
    expect((await svc.listExecutions(B.adminCtx())).data.some((e) => e.id === r.executionId)).toBe(false);
    const leaked = await p.db.withTenant({ organizationId: B.org.id }, (tx) => tx.select().from(integrationExecutions).where(eq(integrationExecutions.id, r.executionId)));
    expect(leaked).toHaveLength(0);
  });
});
