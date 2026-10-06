import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, apiKeysMetadata, auditEvents, eq, eventOutbox, sql } from "../../packages/db/src";
import { agentGovernanceService, type AgentGovernanceService } from "../../modules/agent-governance/src";
import { agentActions, agentIdentities, agentPolicyEvaluations, agents } from "../../modules/agent-governance/src/schema";
import { integrationService } from "../../modules/integration-hub/src";
import { type TenantContext } from "../../packages/shared-types/src";
import { addMember, createOrg, createTestPlatform, expectCode, uniq } from "../helpers/platform";

type P = Awaited<ReturnType<typeof createTestPlatform>>;
type Org = Awaited<ReturnType<typeof createOrg>>;
type Member = Awaited<ReturnType<typeof addMember>>;

let p: P;
let svc: AgentGovernanceService;
let A: Org;
let B: Org;
let aiAdmin: Member; // second approver (separation of duties)
let leader: Member; // agent.approval.review, not agent.manage
let owner: Member;
let sandboxId: string;

/** Authenticate a raw API key exactly as the HTTP layer does and build the agent's tenant context. */
async function asKey(raw: string): Promise<TenantContext> {
  const r = await p.apiKeys.authenticate(raw);
  if (!r) throw new Error("authentication failed");
  return { organizationId: r.organizationId, actor: r.actor, correlationId: randomUUID(), cache: new Map() };
}

/** Register an agent as the org admin, assign an owner, approve as the AI admin, issue a key. */
async function approvedAgent(o: Org, approver: Member, opts: { name?: string; scopes?: string[]; environment?: "production" | "development" } = {}) {
  const a = await svc.registerAgent(o.adminCtx(), { name: opts.name ?? uniq("Agent"), ownerUserId: owner.user.id, businessPurpose: "Test agent", environment: opts.environment ?? "production" });
  await svc.setStatus(approver.ctx(), a.id, { status: "approved" });
  const k = await svc.issueApiKey(o.adminCtx(), a.id, { scopes: opts.scopes ?? ["integration.execute", "integration.connector.use", "connector.use"] });
  return { agent: a, key: k.key, identityId: k.identityId };
}

const outboxTypes = async (orgId: string) => (await p.db.withSystem("test", (tx) => tx.select({ type: eventOutbox.type }).from(eventOutbox).where(eq(eventOutbox.organizationId, orgId)))).map((e) => e.type);
const auditActions = async (orgId: string, resourceId?: string) =>
  (await p.db.withSystem("test", (tx) => tx.select({ action: auditEvents.action }).from(auditEvents).where(and(eq(auditEvents.organizationId, orgId), resourceId ? eq(auditEvents.resourceId, resourceId) : undefined)))).map((e) => e.action);

beforeAll(async () => {
  p = await createTestPlatform();
  svc = agentGovernanceService(p);
  A = await createOrg(p);
  B = await createOrg(p);
  for (const o of [A, B]) {
    await p.modules.enable(o.adminCtx(), "agent_governance");
    await p.modules.enable(o.adminCtx(), "integration_hub");
  }
  aiAdmin = await addMember(p, A.org.id, ["ai_admin"]);
  leader = await addMember(p, A.org.id, ["department_leader"]);
  owner = await addMember(p, A.org.id, ["standard_user"]);
  sandboxId = (await p.connectors.create(A.adminCtx(), { type: "sandbox", name: uniq("sbx"), authType: "none", config: {} })).id;
  const ih = integrationService(p);
  await ih.installTemplate(A.adminCtx(), { templateKey: "sandbox.list_records", connectorId: sandboxId, key: "crm.lookup", aiExposed: true });
  await ih.installTemplate(A.adminCtx(), { templateKey: "sandbox.create_record", connectorId: sandboxId, key: "crm.write", aiExposed: true });
});
afterAll(() => p.close());

describe("Agent Governance — registration and entitlement", () => {
  it("registers permissions, events, policy kind and jobs in the shared registries", () => {
    for (const k of ["agent.read", "agent.register", "agent.manage", "agent.suspend", "agent.policy.read", "agent.policy.manage", "agent.action.read", "agent.approval.review", "agent.audit.read", "agent.incident.manage"]) {
      expect(p.rbac.registry.get(k)?.owner).toBe("agent_governance");
    }
    for (const t of ["agent.registered", "agent.approved", "agent.suspended", "agent.action.requested", "agent.action.allowed", "agent.action.denied", "agent.approval.required", "agent.incident.created"]) {
      expect(p.events.registry.get(t)?.owner).toBe("agent_governance");
    }
    expect(p.policies.kinds().find((k) => k.key === "agent_action")?.owner).toBe("agent_governance");
    expect(p.jobs.registeredTypes()).toEqual(expect.arrayContaining(["agent_governance.approval.expire", "agent_governance.review.reminder", "agent_governance.retention"]));
  });
  it("is unusable until enabled", async () => {
    const C = await createOrg(p);
    await expectCode(svc.listAgents(C.adminCtx()), "MODULE_NOT_ENABLED");
  });
});

describe("Agent Governance — inventory lifecycle", () => {
  it("new agents start pending; the registrant cannot approve; an owner is required", async () => {
    const a = await svc.registerAgent(A.adminCtx(), { name: uniq("Pending") });
    expect(a.status).toBe("pending");
    await expectCode(svc.setStatus(A.adminCtx(), a.id, { status: "approved" }), "FORBIDDEN");
    await expectCode(svc.setStatus(aiAdmin.ctx(), a.id, { status: "approved" }), "VALIDATION_FAILED");
    await svc.updateAgent(aiAdmin.ctx(), a.id, { ownerUserId: owner.user.id });
    expect((await svc.setStatus(aiAdmin.ctx(), a.id, { status: "approved" })).status).toBe("approved");
    const detail = await svc.getAgent(A.adminCtx(), a.id);
    expect(detail.versions.length).toBeGreaterThanOrEqual(3);
    expect(detail.risk?.components).toHaveLength(9);
    expect(detail.reviews.filter((r) => r.status === "scheduled")).toHaveLength(1);
    expect(await outboxTypes(A.org.id)).toEqual(expect.arrayContaining(["agent.registered", "agent.approved"]));
  });
  it("duplicate names conflict; owners must be members of the organization", async () => {
    const name = uniq("Dup");
    await svc.registerAgent(A.adminCtx(), { name });
    await expectCode(svc.registerAgent(A.adminCtx(), { name }), "CONFLICT");
    await expectCode(svc.registerAgent(A.adminCtx(), { name: uniq("X"), ownerUserId: B.admin.id }), "VALIDATION_FAILED");
  });
  it("read-only roles cannot register", async () => {
    const auditor = await addMember(p, A.org.id, ["auditor"]);
    expect((await svc.listAgents(auditor.ctx())).length).toBeGreaterThan(0);
    await expectCode(svc.registerAgent(auditor.ctx(), { name: uniq("Nope") }), "FORBIDDEN");
  });
});

describe("Agent Governance — identities and credentials", () => {
  it("issues a shared API key once; only its hash is stored; the key authenticates AS the agent", async () => {
    const { agent, key, identityId } = await approvedAgent(A, aiAdmin);
    const [row] = await p.db.withSystem("test", (tx) => tx.select().from(agentIdentities).where(eq(agentIdentities.id, identityId)));
    expect(JSON.stringify(row)).not.toContain(key);
    const [k] = await p.db.withSystem("test", (tx) => tx.select().from(apiKeysMetadata).where(eq(apiKeysMetadata.id, row!.apiKeyId!)));
    expect(k!.keyHash).not.toContain(key);
    const ctx = await asKey(key);
    expect(ctx.actor).toMatchObject({ type: "agent", id: agent.id });
    expect(await p.rbac.authorizer.can(ctx, "integration.execute")).toBe(true);
    // Scopes bound the agent: nothing beyond them.
    expect(await p.rbac.authorizer.can(ctx, "agent.read")).toBe(false);
  });
  it("external identity secrets go to the shared secret store, never the identities table", async () => {
    const { agent } = await approvedAgent(A, aiAdmin);
    const secret = `client-secret-${uniq()}`;
    const { identityId } = await svc.addExternalIdentity(A.adminCtx(), agent.id, { kind: "oauth_client", subject: "client-123", issuer: "https://idp.example.com", secret });
    const [row] = await p.db.withSystem("test", (tx) => tx.select().from(agentIdentities).where(eq(agentIdentities.id, identityId)));
    expect(row!.secretRef).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain(secret);
    const audits = await p.db.withSystem("test", (tx) => tx.select().from(auditEvents).where(eq(auditEvents.organizationId, A.org.id)));
    expect(JSON.stringify(audits)).not.toContain(secret);
  });
  it("credential revocation: the key stops authenticating and the secret is destroyed", async () => {
    const { agent, key, identityId } = await approvedAgent(A, aiAdmin);
    const ext = await svc.addExternalIdentity(A.adminCtx(), agent.id, { kind: "certificate", subject: "CN=agent", secret: "-----BEGIN KEY-----x" });
    await svc.revokeIdentity(A.adminCtx(), identityId);
    expect(await p.apiKeys.authenticate(key)).toBeNull();
    await svc.revokeIdentity(A.adminCtx(), ext.identityId);
    const rows = await p.db.withSystem("test", (tx) => tx.select().from(agentIdentities).where(eq(agentIdentities.agentId, agent.id)));
    expect(rows.every((r) => r.status === "revoked" && r.secretRef === null)).toBe(true);
    expect(await auditActions(A.org.id, agent.id)).toEqual(expect.arrayContaining(["agent.credential_issued", "agent.identity_added", "agent.credential_revoked"]));
  });
  it("cannot delegate scopes the issuer does not hold", async () => {
    const { agent } = await approvedAgent(A, aiAdmin);
    await expectCode(svc.issueApiKey(leader.ctx(), agent.id, { scopes: ["org.manage"] }), "FORBIDDEN");
  });
});

describe("Agent Governance — least privilege and policy decisions", () => {
  let ctx: TenantContext;
  let agentId: string;
  const name = `RefundAgent-${uniq()}`;
  beforeAll(async () => {
    const r = await approvedAgent(A, aiAdmin, { name });
    ctx = await asKey(r.key);
    agentId = r.agent.id;
  });

  it("denies everything without a binding (least privilege), and logs the evaluation", async () => {
    const before = await p.db.withSystem("test", (tx) => tx.select({ n: sql<number>`count(*)::int` }).from(agentPolicyEvaluations).where(eq(agentPolicyEvaluations.agentId, agentId)));
    const r = await svc.requestAction(ctx, { actionType: "EXECUTE", action: "refund", system: "stripe", resource: "Charge/ch_1", amount: 20 });
    expect(r.decision).toBe("DENY");
    expect(r.status).toBe("denied");
    const after = await p.db.withSystem("test", (tx) => tx.select({ n: sql<number>`count(*)::int` }).from(agentPolicyEvaluations).where(eq(agentPolicyEvaluations.agentId, agentId)));
    expect(after[0]!.n).toBe(before[0]!.n + 1);
  });
  it("bindings grant exactly their scope", async () => {
    await svc.addBinding(A.adminCtx(), agentId, { actionType: "EXECUTE", system: "stripe", resource: "Charge/*", financialLimit: 5000, maxDataSensitivity: "confidential" });
    expect((await svc.requestAction(ctx, { actionType: "EXECUTE", action: "refund", system: "stripe", resource: "Charge/ch_1", amount: 20 })).decision).toBe("ALLOW");
    expect((await svc.requestAction(ctx, { actionType: "DELETE", action: "delete", system: "stripe", resource: "Charge/ch_1" })).decision).toBe("DENY");
    expect((await svc.requestAction(ctx, { actionType: "EXECUTE", action: "refund", system: "paypal", resource: "Charge/ch_1" })).decision).toBe("DENY");
    expect((await svc.requestAction(ctx, { actionType: "EXECUTE", action: "refund", system: "stripe", resource: "Customer/cus_1" })).decision).toBe("DENY");
    expect((await svc.requestAction(ctx, { actionType: "EXECUTE", action: "refund", system: "stripe", resource: "Charge/ch_1", dataSensitivity: "restricted" })).decision).toBe("DENY");
    expect((await svc.requestAction(ctx, { actionType: "EXECUTE", action: "refund", system: "stripe", resource: "Charge/ch_1", amount: 9000 })).decision).toBe("REQUIRE_APPROVAL");
  });
  it("organization agent_action policies tighten decisions: RefundAgent + refund + amount > 500 → REQUIRE_APPROVAL", async () => {
    await p.policies.create(A.adminCtx(), {
      key: "agents.refunds", name: "Refund guard", kind: "agent_action",
      definition: { combining: "deny-overrides", defaultEffect: "ALLOW", rules: [{ id: "big-refunds", description: "", effect: "REQUIRE_APPROVAL", actions: ["refund"], when: { all: [{ field: "subject.attributes.name", op: "eq", value: name }, { field: "context.amount", op: "gt", value: 500 }] } }] },
    });
    await p.policies.activate(A.adminCtx(), "agents.refunds", 1);
    expect((await svc.requestAction(ctx, { actionType: "EXECUTE", action: "refund", system: "stripe", resource: "Charge/ch_2", amount: 400 })).decision).toBe("ALLOW");
    const big = await svc.requestAction(ctx, { actionType: "EXECUTE", action: "refund", system: "stripe", resource: "Charge/ch_2", amount: 900 });
    expect(big.decision).toBe("REQUIRE_APPROVAL");
    expect(big.approvalId).toBeTruthy();
    const evals = await svc.listEvaluations(A.adminCtx(), { agentId });
    expect((evals[0]!.policies as Array<{ key: string }>).map((x) => x.key)).toContain("agents.refunds");
    // A policy can never loosen a binding DENY.
    expect((await svc.requestAction(ctx, { actionType: "DELETE", action: "refund", system: "stripe", resource: "Charge/ch_2" })).decision).toBe("DENY");
  });
  it("simulation is logged separately and does not count as a violation", async () => {
    const r = await svc.simulate(A.adminCtx(), agentId, { actionType: "EXPORT", action: "export", system: "stripe" });
    expect(r.effect).toBe("DENY");
    expect((await svc.listEvaluations(A.adminCtx(), { agentId, source: "simulation" })).length).toBe(1);
  });
  it("idempotency keys return the original request", async () => {
    const one = await svc.requestAction(ctx, { actionType: "EXECUTE", action: "refund", system: "stripe", resource: "Charge/ch_3", amount: 1, idempotencyKey: "refund-ch3-0001" });
    const two = await svc.requestAction(ctx, { actionType: "EXECUTE", action: "refund", system: "stripe", resource: "Charge/ch_3", amount: 1, idempotencyKey: "refund-ch3-0001" });
    expect(two.id).toBe(one.id);
    expect(two.duplicate).toBe(true);
  });
  it("only agent identities can call the runtime API", async () => {
    await expectCode(svc.requestAction(A.adminCtx(), { actionType: "READ", action: "x", system: "y" }), "FORBIDDEN");
  });
});

describe("Agent Governance — human approval", () => {
  let ctx: TenantContext;
  let agentId: string;
  beforeAll(async () => {
    const r = await approvedAgent(A, aiAdmin);
    ctx = await asKey(r.key);
    agentId = r.agent.id;
    await svc.addBinding(A.adminCtx(), agentId, { actionType: "SEND", system: "email", requiresApproval: true });
  });

  it("an un-approved request cannot be executed; approval shows full context; clarification round-trips", async () => {
    const requester = await addMember(p, A.org.id, ["department_leader"]);
    const s = await svc.startSession(ctx, { instruction: "Email the customer about their refund", onBehalfOfUserId: requester.user.id });
    const r = await svc.requestAction(ctx, { sessionId: s.sessionId, actionType: "SEND", action: "send_email", system: "email", resource: "customer@example.com", justification: "Customer asked for confirmation", affectedRecords: ["case-1"] });
    expect(r.status).toBe("pending_approval");
    await expectCode(svc.reportResult(ctx, r.id, { status: "executed" }), "CONFLICT");

    const ap = (await svc.listApprovals(leader.ctx(), { status: "pending" })).find((x) => x.requestId === r.id)!;
    expect(ap).toMatchObject({ reason: "Customer asked for confirmation", affectedSystems: ["email"], dataSensitivity: "internal" });
    expect(ap.policy).toMatchObject({ effect: "REQUIRE_APPROVAL" });

    // Separation of duties: the user the agent acts for cannot decide (even with the permission).
    await expectCode(svc.decideApproval(requester.ctx(), ap.id, { decision: "approve" }), "FORBIDDEN");
    // Agents never decide.
    await expectCode(svc.decideApproval(ctx, ap.id, { decision: "approve" }), "FORBIDDEN");

    await svc.decideApproval(leader.ctx(), ap.id, { decision: "request_clarification", note: "Which refund?" });
    expect((await svc.getRequest(ctx, r.id)).status).toBe("clarification_requested");
    await svc.respondToClarification(ctx, r.id, { message: "Refund ch_1 for $20" });
    const approved = await svc.decideApproval(leader.ctx(), ap.id, { decision: "approve", note: "OK" });
    expect(approved.status).toBe("approved");
    expect(approved.conversation.map((c) => c.kind)).toEqual(["clarification_request", "clarification", "decision"]);
    await expectCode(svc.decideApproval(leader.ctx(), ap.id, { decision: "reject" }), "CONFLICT");
    expect((await svc.reportResult(ctx, r.id, { status: "executed", result: { messageId: "m1" } })).status).toBe("executed");
    await svc.endSession(ctx, s.sessionId, { status: "completed" });

    const session = await svc.getSession(A.adminCtx(), s.sessionId);
    const kinds = session.steps.map((t) => t.kind);
    expect(kinds).toEqual(expect.arrayContaining(["instruction", "action_proposed", "policy_decision", "approval", "action_executed"]));
    expect(await auditActions(A.org.id, ap.id)).toEqual(expect.arrayContaining(["agent.approval_decided"]));
    expect(await outboxTypes(A.org.id)).toEqual(expect.arrayContaining(["agent.action.requested", "agent.approval.required", "agent.action.allowed"]));
  });
  it("escalated approvals need agent.manage to decide", async () => {
    const r = await svc.requestAction(ctx, { actionType: "SEND", action: "send_email", system: "email", resource: "vip@example.com" });
    await svc.decideApproval(leader.ctx(), r.approvalId!, { decision: "escalate", note: "VIP" });
    await expectCode(svc.decideApproval(leader.ctx(), r.approvalId!, { decision: "approve" }), "FORBIDDEN");
    expect((await svc.decideApproval(aiAdmin.ctx(), r.approvalId!, { decision: "reject", note: "No" })).status).toBe("rejected");
    expect((await svc.getRequest(ctx, r.id)).status).toBe("rejected");
  });
  it("expired approvals cannot be decided", async () => {
    const r = await svc.requestAction(ctx, { actionType: "SEND", action: "send_email", system: "email", resource: "late@example.com" });
    await p.db.withSystem("test", (tx) => tx.execute(sql`update agent_approvals set expires_at = now() - interval '1 minute' where id = ${r.approvalId}`));
    await svc.expireApproval(A.org.id, r.approvalId!);
    expect((await svc.getRequest(ctx, r.id)).status).toBe("expired");
    await expectCode(svc.decideApproval(leader.ctx(), r.approvalId!, { decision: "approve" }), "CONFLICT");
  });
});

describe("Agent Governance — kill switch", () => {
  it("requires typed confirmation and agent.suspend", async () => {
    const { agent } = await approvedAgent(A, aiAdmin);
    await expectCode(svc.emergency(A.adminCtx(), agent.id, { action: "suspend", reason: "Testing it", confirm: "wrong" }), "VALIDATION_FAILED");
    await expectCode(svc.emergency(leader.ctx(), agent.id, { action: "suspend", reason: "Testing it", confirm: agent.name }), "FORBIDDEN");
  });
  it("suspension: permissions vanish immediately, pending approvals and sessions are cancelled, an incident opens", async () => {
    const { agent, key } = await approvedAgent(A, aiAdmin);
    await svc.addBinding(A.adminCtx(), agent.id, { actionType: "SEND", system: "email", requiresApproval: true });
    const ctx = await asKey(key);
    const s = await svc.startSession(ctx, {});
    const pending = await svc.requestAction(ctx, { sessionId: s.sessionId, actionType: "SEND", action: "send", system: "email" });
    const res = await svc.emergency(A.adminCtx(), agent.id, { action: "suspend", reason: "Unexpected behaviour", confirm: agent.name });
    expect(res.incidentId).toBeTruthy();

    const fresh = await asKey(key); // key still authenticates as the agent, but carries no permissions
    expect(await p.rbac.authorizer.can(fresh, "integration.execute")).toBe(false);
    expect((await svc.requestAction(fresh, { actionType: "SEND", action: "send", system: "email" })).decision).toBe("DENY");
    await expectCode(svc.startSession(fresh, {}), "FORBIDDEN");
    expect((await svc.getRequest(fresh, pending.id)).status).toBe("cancelled");
    expect((await svc.getSession(A.adminCtx(), s.sessionId)).status).toBe("terminated");
    expect((await svc.listIncidents(A.adminCtx(), { agentId: agent.id }))[0]).toMatchObject({ kind: "kill_switch", status: "open" });
    expect(await auditActions(A.org.id, agent.id)).toContain("agent.emergency_suspend");
    expect(await outboxTypes(A.org.id)).toEqual(expect.arrayContaining(["agent.suspended", "agent.incident.created"]));

    // Reinstating needs agent.suspend as well as agent.manage (ai_admin holds both).
    expect((await svc.setStatus(aiAdmin.ctx(), agent.id, { status: "approved" })).status).toBe("approved");
    expect(await p.rbac.authorizer.can(await asKey(key), "integration.execute")).toBe(true);
  });
  it("quarantine revokes credentials and disables every binding", async () => {
    const { agent, key } = await approvedAgent(A, aiAdmin);
    await svc.addBinding(A.adminCtx(), agent.id, { actionType: "READ", system: "crm" });
    const res = await svc.emergency(A.adminCtx(), agent.id, { action: "quarantine", reason: "Compromised credentials", confirm: agent.name });
    expect(res.actions.map((a) => a.action)).toEqual(["quarantine", "revoke_credentials", "disable_capability"]);
    expect(await p.apiKeys.authenticate(key)).toBeNull();
    const d = await svc.getAgent(A.adminCtx(), agent.id);
    expect(d.quarantined).toBe(true);
    expect(d.bindings.every((b) => b.status === "disabled")).toBe(true);
  });
  it("disable_capability and block_connector are targeted", async () => {
    const { agent, key } = await approvedAgent(A, aiAdmin);
    const b = await svc.addBinding(A.adminCtx(), agent.id, { actionType: "READ", system: "crm" });
    const ctx = await asKey(key);
    expect((await svc.requestAction(ctx, { actionType: "READ", action: "read", system: "crm" })).decision).toBe("ALLOW");
    await svc.emergency(A.adminCtx(), agent.id, { action: "disable_capability", reason: "Too broad", confirm: agent.name, bindingId: b.id });
    expect((await svc.requestAction(ctx, { actionType: "READ", action: "read", system: "crm" })).decision).toBe("DENY");

    await svc.addBinding(A.adminCtx(), agent.id, { actionType: "READ", connectorId: sandboxId });
    expect((await svc.requestAction(ctx, { actionType: "READ", action: "read", system: "sandbox", connectorId: sandboxId })).decision).toBe("ALLOW");
    await svc.emergency(A.adminCtx(), agent.id, { action: "block_connector", reason: "Connector incident", confirm: agent.name, connectorId: sandboxId });
    const blocked = await svc.requestAction(ctx, { actionType: "READ", action: "read", system: "sandbox", connectorId: sandboxId });
    expect(blocked.decision).toBe("DENY");
    expect(blocked.reasons[0]).toMatch(/blocked/);
  });
});

describe("Agent Governance — enforcement inside Integration", () => {
  it("agent tool calls through the Integration gateway are bound by agent permissions", async () => {
    const ih = integrationService(p);
    const { agent, key } = await approvedAgent(A, aiAdmin);
    const ctx = await asKey(key);
    // No binding: Integration's shared policy check is denied by the interceptor.
    const denied = await ih.invokeTool(ctx, "crm.lookup", { input: {} });
    expect(denied.error?.class).toBe("policy_denied");
    await svc.addBinding(A.adminCtx(), agent.id, { actionType: "READ", connectorId: sandboxId });
    const ok = await ih.invokeTool(ctx, "crm.lookup", { input: {} });
    expect(ok, JSON.stringify(ok.error)).toMatchObject({ status: "succeeded" });
    // WRITE with a financial limit: over it, Integration pauses for approval.
    await svc.addBinding(A.adminCtx(), agent.id, { actionType: "WRITE", connectorId: sandboxId, financialLimit: 100 });
    expect((await ih.invokeTool(ctx, "crm.write", { input: { name: "Small", amount: 50 } })).status).toBe("succeeded");
    const big = await ih.invokeTool(ctx, "crm.write", { input: { name: "Big", amount: 5000 } });
    expect(big.approvalId).toBeTruthy();
    const evals = await svc.listEvaluations(A.adminCtx(), { agentId: agent.id, source: "integration" });
    expect(evals.map((e) => e.effect)).toEqual(expect.arrayContaining(["DENY", "ALLOW", "REQUIRE_APPROVAL"]));
    // Suspension stops it at the authorizer.
    await svc.emergency(A.adminCtx(), agent.id, { action: "suspend", reason: "Stop now please", confirm: agent.name });
    await expectCode(ih.invokeTool(await asKey(key), "crm.lookup", { input: {} }), "FORBIDDEN");
  });
  it("discovers unknown agents from unverified claims on the gateway", async () => {
    const ih = integrationService(p);
    const claim = `ext-agent-${uniq()}`;
    await ih.invokeTool(A.adminCtx(), "crm.lookup", { input: {}, agent: { id: claim, name: `Shadow ${claim}` } });
    await p.events.bus.dispatchPending(500);
    const found = (await svc.listAgents(A.adminCtx(), { status: "unknown" })).find((a) => a.externalId === claim);
    expect(found).toMatchObject({ discoveredVia: "integration", status: "unknown" });
  });
});

describe("Agent Governance — reviews, dashboard, retention", () => {
  it("completing a review records the attestation and can restrict the agent", async () => {
    const { agent } = await approvedAgent(A, aiAdmin);
    const review = (await svc.listReviews(A.adminCtx(), { status: "scheduled" })).find((r) => r.agentId === agent.id)!;
    expect(review.reviewOwnerUserId).toBe(owner.user.id);
    // The designated review owner still needs agent.read (a standard_user has none).
    await expectCode(svc.completeReview(owner.ctx(), review.id, { purposeValid: true, permissionsValid: false, systemsRequired: true, riskStatus: "elevated", outcome: "restricted" }), "FORBIDDEN");
    await svc.completeReview(aiAdmin.ctx(), review.id, { purposeValid: true, permissionsValid: false, systemsRequired: true, riskStatus: "elevated", outcome: "restricted", notes: "Too broad" });
    const d = await svc.getAgent(A.adminCtx(), agent.id);
    expect(d.status).toBe("restricted");
    expect(d.lastReviewAt).toBeTruthy();
    expect(d.reviews.filter((r) => r.status === "scheduled")).toHaveLength(1);
    await expectCode(svc.completeReview(aiAdmin.ctx(), review.id, { purposeValid: true, permissionsValid: true, systemsRequired: true, riskStatus: "ok", outcome: "approved" }), "CONFLICT");
  });
  it("the dashboard counts what security needs to see", async () => {
    const d = await svc.dashboard(A.adminCtx());
    expect(d.activeAgents).toBeGreaterThan(3);
    expect(d.suspendedAgents).toBeGreaterThan(0);
    expect(d.unknownAgents).toBeGreaterThan(0);
    expect(d.deniedActions30d).toBeGreaterThan(0);
    expect(d.agentsWithoutOwners).toBeGreaterThan(0);
  });
  it("activity content follows the organization's AI retention setting", async () => {
    const { key, agent } = await approvedAgent(A, aiAdmin);
    const ctx = await asKey(key);
    await p.organizations.updateRetention(A.adminCtx(), { aiPromptRetention: "metadata" });
    await svc.startSession(ctx, { instruction: "secret plan details" });
    await p.organizations.updateRetention(A.adminCtx(), { aiPromptRetention: "full" });
    await svc.startSession(ctx, { instruction: "kept instruction" });
    const rows = await p.db.withSystem("test", (tx) => tx.select().from(agentActions).where(and(eq(agentActions.agentId, agent.id), eq(agentActions.kind, "instruction"))));
    expect(JSON.stringify(rows)).not.toContain("secret plan details");
    expect(JSON.stringify(rows)).toContain("kept instruction");
  });
});

describe("Agent Governance — tenant isolation", () => {
  it("organization B can never see or act on organization A's agents", async () => {
    const { agent, key } = await approvedAgent(A, aiAdmin);
    await svc.addBinding(A.adminCtx(), agent.id, { actionType: "SEND", system: "email", requiresApproval: true });
    const r = await svc.requestAction(await asKey(key), { actionType: "SEND", action: "send", system: "email" });
    await expectCode(svc.getAgent(B.adminCtx(), agent.id), "NOT_FOUND");
    expect((await svc.listAgents(B.adminCtx())).find((a) => a.id === agent.id)).toBeUndefined();
    await expectCode(svc.decideApproval(B.adminCtx(), r.approvalId!, { decision: "approve" }), "NOT_FOUND");
    await expectCode(svc.emergency(B.adminCtx(), agent.id, { action: "suspend", reason: "cross tenant", confirm: agent.name }), "NOT_FOUND");
    await expectCode(svc.addBinding(B.adminCtx(), agent.id, { actionType: "READ" }), "NOT_FOUND");
    await expectCode(svc.getRequest(B.adminCtx(), r.id), "NOT_FOUND");
    expect((await svc.listApprovals(B.adminCtx())).length).toBe(0);
    // Row-level security: a B-scoped transaction sees no A rows even without a WHERE clause.
    const rows = await p.db.withTenant({ organizationId: B.org.id }, (tx) => tx.select().from(agents));
    expect(rows.every((x) => x.organizationId === B.org.id)).toBe(true);
  });
  it("an agent of A carries no permissions in B and cannot bind B's connectors", async () => {
    const { agent, key } = await approvedAgent(A, aiAdmin);
    const ctx = await asKey(key);
    expect(ctx.organizationId).toBe(A.org.id);
    const forged: TenantContext = { ...ctx, organizationId: B.org.id, cache: new Map() };
    expect(await p.rbac.authorizer.can(forged, "integration.execute")).toBe(false);
    await expectCode(svc.requestAction(forged, { actionType: "READ", action: "read", system: "crm" }), "NOT_FOUND");
    const bConnector = await p.connectors.create(B.adminCtx(), { type: "sandbox", name: uniq("bsbx"), authType: "none", config: {} });
    await expectCode(svc.addBinding(A.adminCtx(), agent.id, { actionType: "READ", connectorId: bConnector.id }), "VALIDATION_FAILED");
    await expectCode(svc.emergency(A.adminCtx(), agent.id, { action: "block_connector", reason: "cross tenant", confirm: agent.name, connectorId: bConnector.id }), "NOT_FOUND");
  });
});

describe("Agent Governance — audit completeness", () => {
  it("every governance action lands in the shared audit log", async () => {
    const actions = new Set(await auditActions(A.org.id));
    for (const a of [
      "agent.registered", "agent.approved", "agent.updated", "agent.credential_issued", "agent.credential_revoked", "agent.identity_added", "agent.binding_added",
      "agent.action_requested", "agent.action_executed", "agent.approval_decided", "agent.emergency_suspend", "agent.emergency_quarantine", "agent.emergency_disable_capability",
      "agent.emergency_block_connector", "agent.incident_created", "agent.review_completed",
    ]) expect(actions, a).toContain(a);
  });
});
