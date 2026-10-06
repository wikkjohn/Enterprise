import { z } from "zod";
import { type AuditService } from "@eaop/audit";
import { type ApiKeyService } from "@eaop/auth";
import { and, connectors, desc, eq, gte, ilike, inArray, lte, or, scopeOf, sql, users, type Database, type Tx } from "@eaop/db";
import { type EventBus } from "@eaop/events";
import { type JobQueue } from "@eaop/jobs";
import { type ModuleService } from "@eaop/module-registry";
import { type NotificationService } from "@eaop/notifications";
import { redactString, type Logger } from "@eaop/observability";
import { type OrganizationService } from "@eaop/organizations";
import { type PolicyEngine, type PolicyInput, type PolicyService } from "@eaop/policies";
import { type Authorizer, type PermissionRegistry } from "@eaop/rbac";
import { type SecretStore } from "@eaop/secrets";
import { AppError, conflict, forbidden, isUuid, notFound, SYSTEM_ACTOR, type TenantContext } from "@eaop/shared-types";
import { type UsageService } from "@eaop/usage";
import { actionTypeForOperation, decide, strictest, type ActionRequestInput, type BindingForDecision, type Decision } from "./decision";
import { REVIEW_INTERVAL_DAYS, scoreAgent, type RiskResult } from "./risk";
import {
  ACTION_TYPES, ACTIVITY_KINDS, AGENT_STATUSES, AUTONOMY_LEVELS, ENVIRONMENTS, RISK_LEVELS, SENSITIVITY,
  agentActionRequests, agentActions, agentApprovals, agentIdentities, agentIncidents, agentPermissionBindings, agentPolicyEvaluations, agentReviews,
  agentRiskAssessments, agents, agentSessions, agentVersions, type ActivityKind, type ConversationEntry, type Effect, type RequestStatus,
} from "./schema";

export const MODULE_ID = "agent_governance" as const;
export const APPROVAL_EXPIRE_JOB = "agent_governance.approval.expire";
export const REVIEW_REMINDER_JOB = "agent_governance.review.reminder";
export const RETENTION_JOB = "agent_governance.retention";
const BASE = "/m/agent-governance";

function parse<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.output<S> {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  throw new AppError("VALIDATION_FAILED", r.error.issues[0] ? `${r.error.issues[0].path.join(".") || "input"}: ${r.error.issues[0].message}` : "Request validation failed.", {
    issues: r.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })),
  });
}

// ── Input schemas ───────────────────────────────────────────────────────────

const text = (max: number) => z.string().trim().max(max);
export const agentInputSchema = z.object({
  name: text(120).min(1),
  description: text(4000).default(""),
  externalId: text(200).nullish(),
  ownerUserId: z.string().uuid().nullish(),
  department: text(120).nullish(),
  businessPurpose: text(4000).default(""),
  environment: z.enum(ENVIRONMENTS).default("development"),
  provider: text(120).nullish(),
  model: text(120).nullish(),
  autonomyLevel: z.enum(AUTONOMY_LEVELS).default("supervised"),
  riskCategory: z.enum(RISK_LEVELS).default("medium"),
  connectedSystems: z.array(text(120).min(1)).max(50).default([]),
  customerImpact: z.number().int().min(1).max(5).nullish(),
  regulatoryImpact: z.number().int().min(1).max(5).nullish(),
});
export const agentUpdateSchema = agentInputSchema.partial().extend({ changeNote: text(500).optional() });

const timeWindowSchema = z.object({
  days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(0).max(24),
  timeZone: z.string().max(64).optional(),
});
export const bindingInputSchema = z.object({
  actionType: z.enum(ACTION_TYPES),
  system: text(120).min(1).default("*"),
  connectorId: z.string().uuid().nullish(),
  resource: text(300).min(1).default("*"),
  environment: z.enum(["any", ...ENVIRONMENTS]).default("any"),
  maxDataSensitivity: z.enum(SENSITIVITY).default("internal"),
  financialLimit: z.number().min(0).max(1e12).nullish(),
  timeWindow: timeWindowSchema.nullish(),
  conditions: z.unknown().optional(),
  requiresApproval: z.boolean().default(false),
  description: text(1000).default(""),
  expiresAt: z.coerce.date().nullish(),
});

export const actionRequestSchema = z.object({
  sessionId: z.string().uuid().nullish(),
  actionType: z.enum(ACTION_TYPES),
  action: text(120).min(1),
  system: text(120).min(1),
  connectorId: z.string().uuid().nullish(),
  resource: text(300).min(1).default("*"),
  environment: z.enum(ENVIRONMENTS).optional(),
  dataSensitivity: z.enum(SENSITIVITY).default("internal"),
  amount: z.number().min(0).max(1e12).nullish(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullish(),
  justification: text(2000).optional(),
  affectedRecords: z.array(z.unknown()).max(100).optional(),
  context: z.record(z.unknown()).default({}),
  idempotencyKey: z.string().min(8).max(200).optional(),
});

export const decisionSchema = z.object({ decision: z.enum(["approve", "reject", "request_clarification", "escalate"]), note: text(2000).optional() });

export const emergencySchema = z.object({
  action: z.enum(["suspend", "disable_capability", "revoke_credentials", "block_connector", "quarantine"]),
  reason: text(2000).min(5),
  /** Must equal the agent's name. */
  confirm: z.string().max(120),
  bindingId: z.string().uuid().optional(),
  connectorId: z.string().uuid().optional(),
});

export const reviewCompleteSchema = z.object({
  purposeValid: z.boolean(),
  permissionsValid: z.boolean(),
  systemsRequired: z.boolean(),
  riskStatus: text(200).min(1),
  outcome: z.enum(["approved", "changes_required", "restricted", "retired"]),
  notes: text(4000).optional(),
});

// ── Views ───────────────────────────────────────────────────────────────────

type AgentRow = typeof agents.$inferSelect;
type BindingRow = typeof agentPermissionBindings.$inferSelect;
type RequestRow = typeof agentActionRequests.$inferSelect;
type ApprovalRow = typeof agentApprovals.$inferSelect;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export interface AgentView {
  id: string;
  name: string;
  description: string;
  externalId: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  department: string | null;
  businessPurpose: string;
  environment: string;
  status: string;
  quarantined: boolean;
  provider: string | null;
  model: string | null;
  autonomyLevel: string;
  riskCategory: string;
  connectedSystems: string[];
  blockedConnectorIds: string[];
  customerImpact: number | null;
  regulatoryImpact: number | null;
  discoveredVia: string;
  currentVersion: number;
  lastActivityAt: string | null;
  lastReviewAt: string | null;
  approvedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSummary extends AgentView {
  riskScore: number | null;
  riskBand: string | null;
  openIncidents: number;
  pendingApprovals: number;
  nextReviewAt: string | null;
  privileged: boolean;
}

const agentView = (a: AgentRow, ownerName: string | null = null): AgentView => ({
  id: a.id, name: a.name, description: a.description, externalId: a.externalId, ownerUserId: a.ownerUserId, ownerName, department: a.department, businessPurpose: a.businessPurpose,
  environment: a.environment, status: a.status, quarantined: a.quarantined, provider: a.provider, model: a.model, autonomyLevel: a.autonomyLevel, riskCategory: a.riskCategory,
  connectedSystems: a.connectedSystems, blockedConnectorIds: a.blockedConnectorIds, customerImpact: a.customerImpact, regulatoryImpact: a.regulatoryImpact, discoveredVia: a.discoveredVia,
  currentVersion: a.currentVersion, lastActivityAt: iso(a.lastActivityAt), lastReviewAt: iso(a.lastReviewAt), approvedAt: iso(a.approvedAt), createdBy: a.createdBy, createdAt: a.createdAt.toISOString(), updatedAt: a.updatedAt.toISOString(),
});

export const bindingView = (b: BindingRow) => ({
  id: b.id, actionType: b.actionType, system: b.system, connectorId: b.connectorId, resource: b.resource, environment: b.environment, maxDataSensitivity: b.maxDataSensitivity,
  financialLimit: b.financialLimit, timeWindow: b.timeWindow, conditions: b.conditions ?? null, requiresApproval: b.requiresApproval, status: b.status, description: b.description,
  expiresAt: iso(b.expiresAt), createdAt: b.createdAt.toISOString(),
});
export type BindingView = ReturnType<typeof bindingView>;

export const requestView = (r: RequestRow, agentName: string | null = null) => ({
  id: r.id, agentId: r.agentId, agentName, sessionId: r.sessionId, actionType: r.actionType, action: r.action, system: r.system, connectorId: r.connectorId, resource: r.resource,
  environment: r.environment, dataSensitivity: r.dataSensitivity, amount: r.amount, currency: r.currency, decision: r.decision, status: r.status, reasons: r.reasons, bindingId: r.bindingId,
  result: r.result ?? null, executedAt: iso(r.executedAt), createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
});
export type RequestView = ReturnType<typeof requestView>;

export const approvalView = (a: ApprovalRow, extra: { agentName?: string | null; request?: RequestView | null } = {}) => ({
  id: a.id, requestId: a.requestId, agentId: a.agentId, agentName: extra.agentName ?? null, status: a.status, reason: a.reason, affectedSystems: a.affectedSystems,
  affectedRecords: a.affectedRecords ?? null, financialImpact: a.financialImpact, dataSensitivity: a.dataSensitivity, policy: a.policy, supportingContext: a.supportingContext ?? null,
  escalationLevel: a.escalationLevel, conversation: a.conversation, decidedBy: a.decidedBy, decidedAt: iso(a.decidedAt), decisionNote: a.decisionNote, expiresAt: a.expiresAt.toISOString(),
  createdAt: a.createdAt.toISOString(), request: extra.request ?? null,
});
export type ApprovalView = ReturnType<typeof approvalView>;

export const activityView = (x: typeof agentActions.$inferSelect) => ({
  id: x.id, agentId: x.agentId, sessionId: x.sessionId, requestId: x.requestId, kind: x.kind, source: x.source, system: x.system, resource: x.resource, actionType: x.actionType,
  decision: x.decision, summary: x.summary, detail: x.detail ?? null, occurredAt: x.occurredAt.toISOString(),
});
export type ActivityView = ReturnType<typeof activityView>;

export interface DashboardView {
  activeAgents: number;
  unknownAgents: number;
  highRiskAgents: number;
  suspendedAgents: number;
  privilegedAgents: number;
  policyViolations30d: number;
  deniedActions30d: number;
  pendingApprovals: number;
  sensitiveDataAccess30d: number;
  agentsWithoutOwners: number;
  staleReviews: number;
  openIncidents: number;
  byStatus: Array<{ label: string; value: number }>;
  decisions30d: Array<{ label: string; value: number }>;
  attention: Array<{ agentId: string; name: string; reasons: string[] }>;
}

const PRIVILEGED = new Set(["WRITE", "CREATE", "UPDATE", "DELETE", "SEND", "EXECUTE", "APPROVE", "EXPORT"]);
const isPrivileged = (bs: Array<{ actionType: string; maxDataSensitivity: string; financialLimit: number | null; environment: string; status: string }>, agentEnv: string) =>
  bs.some((b) => b.status === "active" && ((PRIVILEGED.has(b.actionType) && (agentEnv === "production" || b.environment === "production")) || b.maxDataSensitivity === "restricted" || b.actionType === "APPROVE" || (b.financialLimit ?? 0) >= 10_000));

export interface AgentGovernanceDeps {
  db: Database;
  authorizer: Authorizer;
  audit: AuditService;
  bus: EventBus;
  notifications: NotificationService;
  policies: PolicyService;
  policyEngine: PolicyEngine;
  apiKeys: ApiKeyService;
  secrets: SecretStore;
  jobs: JobQueue;
  organizations: OrganizationService;
  usage: UsageService;
  permissions: PermissionRegistry;
  /** Shared module entitlements: agent runtime calls carry no module permission, so they check enablement directly. */
  modules: Pick<ModuleService, "requireEnabled">;
  logger: Logger;
}

export type AgentGovernanceService = ReturnType<typeof createAgentGovernanceService>;

export function createAgentGovernanceService(deps: AgentGovernanceDeps) {
  const { db, authorizer, audit, bus, notifications, policies, policyEngine, apiKeys, secrets, jobs, organizations, usage, permissions, modules, logger } = deps;
  const tenant = <T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>) => db.withTenant(scopeOf(ctx), fn);
  const orgScope = <T>(orgId: string, fn: (tx: Tx) => Promise<T>) => db.withTenant({ organizationId: orgId }, fn);
  const org = (ctx: TenantContext) => ctx.organizationId;
  const userId = (ctx: TenantContext) => (ctx.actor.type === "user" ? ctx.actor.id : null);
  const record = (ctx: TenantContext, action: string, resourceType: string, resourceId: string, extra: { before?: unknown; after?: unknown; metadata?: Record<string, unknown>; outcome?: "success" | "failure" | "denied" } = {}) =>
    audit.record(ctx, { module: MODULE_ID, action, resourceType, resourceId, ...extra });
  const systemCtx = (ctx: TenantContext): TenantContext => ({ organizationId: ctx.organizationId, actor: SYSTEM_ACTOR("agent_governance"), correlationId: ctx.correlationId, cache: new Map() });
  const uuidOr404 = (id: string, what: string) => {
    if (!isUuid(id)) throw notFound(what, id);
  };

  async function loadAgent(tx: Tx, orgId: string, id: string) {
    uuidOr404(id, "Agent");
    const [a] = await tx.select().from(agents).where(and(eq(agents.organizationId, orgId), eq(agents.id, id))).limit(1);
    if (!a) throw notFound("Agent", id);
    return a;
  }
  async function bindingsOf(tx: Tx, agentId: string) {
    return tx.select().from(agentPermissionBindings).where(eq(agentPermissionBindings.agentId, agentId)).orderBy(agentPermissionBindings.createdAt);
  }

  /** Retention-aware content: "full" keeps redacted content; otherwise metadata only. */
  async function retainContent(orgId: string) {
    return (await organizations.settingsInternal(orgId)).dataRetention.aiPromptRetention === "full";
  }
  const redactDeep = (v: unknown, depth = 0): unknown => {
    if (typeof v === "string") return redactString(v).slice(0, 4000);
    if (!v || typeof v !== "object" || depth > 6) return v;
    if (Array.isArray(v)) return v.slice(0, 100).map((x) => redactDeep(x, depth + 1));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /pass|secret|token|key|authorization|ssn|card/i.test(k) ? "[redacted]" : redactDeep(x, depth + 1)]));
  };

  async function activity(orgId: string, agentId: string, a: { sessionId?: string | null; requestId?: string | null; kind: ActivityKind; source?: "agent" | "platform" | "integration"; system?: string | null; resource?: string | null; actionType?: string | null; decision?: string | null; summary: string; detail?: unknown }, full?: boolean) {
    const keep = full ?? (await retainContent(orgId));
    await orgScope(orgId, async (tx) => {
      await tx.insert(agentActions).values({
        organizationId: orgId, agentId, sessionId: a.sessionId ?? null, requestId: a.requestId ?? null, kind: a.kind, source: a.source ?? "platform", system: a.system ?? null,
        resource: a.resource ?? null, actionType: a.actionType ?? null, decision: a.decision ?? null, summary: redactString(a.summary).slice(0, 300),
        detail: a.detail === undefined ? null : keep ? redactDeep(a.detail) : { retained: false, note: "Content not retained (organization retention: metadata only)." },
      });
      await tx.update(agents).set({ lastActivityAt: new Date() }).where(eq(agents.id, agentId));
      if (a.sessionId) await tx.update(agentSessions).set({ lastEventAt: new Date() }).where(eq(agentSessions.id, a.sessionId));
    });
  }

  async function snapshot(tx: Tx, a: AgentRow) {
    const bs = await bindingsOf(tx, a.id);
    return { agent: agentView(a), bindings: bs.map(bindingView) };
  }
  async function newVersion(tx: Tx, ctx: TenantContext, id: string, note: string) {
    const [a] = await tx.update(agents).set({ currentVersion: sql`${agents.currentVersion} + 1`, updatedAt: new Date() }).where(eq(agents.id, id)).returning();
    await tx.insert(agentVersions).values({ organizationId: org(ctx), agentId: id, version: a!.currentVersion, snapshot: await snapshot(tx, a!), changeNote: note, createdBy: userId(ctx) });
    return a!;
  }

  async function computeRisk(orgId: string, agentId: string, by: string | null): Promise<RiskResult> {
    return orgScope(orgId, async (tx) => {
      const a = await loadAgent(tx, orgId, agentId);
      const bs = await bindingsOf(tx, agentId);
      const [v] = await tx.select({ n: sql<number>`count(*)::int` }).from(agentPolicyEvaluations).where(and(eq(agentPolicyEvaluations.agentId, agentId), eq(agentPolicyEvaluations.effect, "DENY"), sql`${agentPolicyEvaluations.source} <> 'simulation'`, gte(agentPolicyEvaluations.createdAt, new Date(Date.now() - 90 * 86400_000))));
      const r = scoreAgent({ environment: a.environment, autonomyLevel: a.autonomyLevel, connectedSystems: a.connectedSystems, customerImpact: a.customerImpact, regulatoryImpact: a.regulatoryImpact, bindings: bs, recentViolations: v?.n ?? 0 });
      await tx.insert(agentRiskAssessments).values({ organizationId: orgId, agentId, modelVersion: r.modelVersion, score: r.score, band: r.band, components: r.components, explanation: r.explanation, computedBy: by });
      return r;
    });
  }

  async function assertMember(tx: Tx, orgId: string, uid: string | null | undefined, field: string) {
    if (!uid) return;
    const rows = await tx.execute(sql`select 1 from memberships where organization_id = ${orgId} and user_id = ${uid} and status = 'active' limit 1`);
    if (!rows.rows.length) throw new AppError("VALIDATION_FAILED", `${field} must be an active member of this organization.`);
  }

  /** Bindings + organization "agent_action" policies (shared engine) → one logged decision. */
  async function evaluate(ctx: TenantContext, a: AgentRow, req: ActionRequestInput, source: "direct" | "integration" | "simulation", requestId: string | null = null) {
    const bs = await orgScope(a.organizationId, (tx) => bindingsOf(tx, a.id));
    const conditionMatches = (condition: unknown, r: ActionRequestInput) =>
      policyEngine.evaluate({ combining: "first-match", defaultEffect: "DENY", rules: [{ id: "binding", description: "", effect: "ALLOW", when: condition as never }] }, { subject: { type: "agent", id: a.id }, resource: { type: r.system, id: r.resource }, action: r.action, context: { ...r.context, amount: r.amount ?? null, environment: r.environment, actionType: r.actionType } }).effect === "ALLOW";
    const base: Decision = decide({ id: a.id, name: a.name, status: a.status, quarantined: a.quarantined, environment: a.environment, blockedConnectorIds: a.blockedConnectorIds }, bs as BindingForDecision[], req, { conditionMatches });
    const policyInput: PolicyInput = {
      subject: { type: "agent", id: a.id, attributes: { name: a.name, environment: a.environment, autonomy: a.autonomyLevel, riskCategory: a.riskCategory, department: a.department, status: a.status } },
      resource: { type: req.system, id: req.resource, attributes: { sensitivity: req.dataSensitivity, connectorId: req.connectorId ?? null } },
      action: req.action,
      context: { ...req.context, actionType: req.actionType, amount: req.amount ?? null, environment: req.environment, source },
    };
    // Organization policies can only tighten a binding-level ALLOW; a binding DENY is final.
    const pol = base.effect === "DENY" ? null : await policies.evaluateKind(ctx, "agent_action", policyInput, { defaultEffect: "ALLOW" });
    const effect: Effect = pol ? strictest(base.effect, pol.effect as Effect) : base.effect;
    const reasons = [...base.reasons, ...(pol && !pol.defaulted ? pol.reasons : [])];
    const policiesUsed = pol?.policies ?? [];
    const [evaluation] = await orgScope(a.organizationId, (tx) =>
      tx.insert(agentPolicyEvaluations).values({ organizationId: a.organizationId, agentId: a.id, requestId, source, input: policyInput as unknown as Record<string, unknown>, effect, reasons, matchedBindings: base.matchedBindingIds, policies: policiesUsed }).returning(),
    );
    return { effect, reasons, bindingId: base.bindingId, matchedBindingIds: base.matchedBindingIds, policies: policiesUsed, evaluationId: evaluation!.id };
  }

  async function selfAgent(ctx: TenantContext) {
    if (ctx.actor.type !== "agent") throw forbidden("Only an agent identity can call this endpoint.");
    await modules.requireEnabled(ctx, MODULE_ID);
    const a = await orgScope(ctx.organizationId, (tx) => loadAgent(tx, ctx.organizationId, ctx.actor.id));
    return a;
  }

  async function scheduleReview(orgId: string, agentId: string, dueAt: Date, ownerId: string | null, reviewOwnerId: string | null) {
    const [r] = await orgScope(orgId, (tx) => tx.insert(agentReviews).values({ organizationId: orgId, agentId, dueAt, agentOwnerUserId: ownerId, reviewOwnerUserId: reviewOwnerId ?? ownerId }).returning());
    const remindAt = new Date(Math.max(Date.now(), dueAt.getTime() - 7 * 86400_000));
    await jobs.enqueue(REVIEW_REMINDER_JOB, { reviewId: r!.id }, { organizationId: orgId, runAt: remindAt, idempotencyKey: `review:${r!.id}` });
    return r!;
  }

  async function openIncident(ctx: TenantContext, agentId: string, i: { kind: "kill_switch" | "policy_violation" | "manual"; severity: "low" | "medium" | "high" | "critical"; title: string; description: string; actions?: Array<{ action: string; detail?: string }>; requestId?: string | null }) {
    const [row] = await orgScope(ctx.organizationId, (tx) =>
      tx.insert(agentIncidents).values({
        organizationId: ctx.organizationId, agentId, kind: i.kind, severity: i.severity, title: i.title, description: i.description, relatedRequestId: i.requestId ?? null, openedBy: userId(ctx),
        actionsTaken: (i.actions ?? []).map((x) => ({ ...x, at: new Date().toISOString(), by: ctx.actor.label })),
      }).returning(),
    );
    await record(ctx, "agent.incident_created", "agent_incident", row!.id, { after: { agentId, kind: i.kind, severity: i.severity, title: i.title } });
    await bus.publish(ctx, "agent.incident.created", { incidentId: row!.id, agentId, kind: i.kind, severity: i.severity });
    await notifications.notify(ctx, { type: "agent.incident", title: `Agent incident: ${i.title}`, body: i.description.slice(0, 500), actionUrl: `${BASE}/incidents?focus=${row!.id}`, priority: i.severity === "critical" || i.severity === "high" ? "high" : "normal", recipients: { permission: "agent.incident.manage" } });
    return row!;
  }

  async function agentSummaries(tx: Tx, orgId: string, rows: AgentRow[]): Promise<AgentSummary[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const risks = await tx.selectDistinctOn([agentRiskAssessments.agentId], { agentId: agentRiskAssessments.agentId, score: agentRiskAssessments.score, band: agentRiskAssessments.band }).from(agentRiskAssessments).where(inArray(agentRiskAssessments.agentId, ids)).orderBy(agentRiskAssessments.agentId, desc(agentRiskAssessments.computedAt));
    const inc = await tx.select({ agentId: agentIncidents.agentId, n: sql<number>`count(*)::int` }).from(agentIncidents).where(and(inArray(agentIncidents.agentId, ids), sql`${agentIncidents.status} <> 'resolved'`)).groupBy(agentIncidents.agentId);
    const appr = await tx.select({ agentId: agentApprovals.agentId, n: sql<number>`count(*)::int` }).from(agentApprovals).where(and(inArray(agentApprovals.agentId, ids), inArray(agentApprovals.status, ["pending", "escalated", "clarification_requested"]))).groupBy(agentApprovals.agentId);
    const rev = await tx.select({ agentId: agentReviews.agentId, due: sql<Date>`min(${agentReviews.dueAt})` }).from(agentReviews).where(and(inArray(agentReviews.agentId, ids), eq(agentReviews.status, "scheduled"))).groupBy(agentReviews.agentId);
    const owners = await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, rows.map((r) => r.ownerUserId).filter((x): x is string => !!x).concat(["00000000-0000-0000-0000-000000000000"])));
    const bs = await tx.select().from(agentPermissionBindings).where(inArray(agentPermissionBindings.agentId, ids));
    return rows.map((a) => {
      const r = risks.find((x) => x.agentId === a.id);
      const due = rev.find((x) => x.agentId === a.id)?.due;
      return {
        ...agentView(a, owners.find((o) => o.id === a.ownerUserId)?.name ?? null),
        riskScore: r ? Number(r.score) : null, riskBand: r?.band ?? null,
        openIncidents: inc.find((x) => x.agentId === a.id)?.n ?? 0, pendingApprovals: appr.find((x) => x.agentId === a.id)?.n ?? 0,
        nextReviewAt: due ? new Date(due).toISOString() : null, privileged: isPrivileged(bs.filter((b) => b.agentId === a.id), a.environment),
      };
    });
  }

  const service = {
    // ── Inventory ─────────────────────────────────────────────────────────
    async listAgents(ctx: TenantContext, q: { status?: string; q?: string; environment?: string } = {}) {
      await authorizer.require(ctx, "agent.read");
      return tenant(ctx, async (tx) => {
        const like = q.q ? `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
        const rows = await tx.select().from(agents).where(and(eq(agents.organizationId, org(ctx)), q.status ? eq(agents.status, q.status as AgentRow["status"]) : undefined, q.environment ? eq(agents.environment, q.environment as AgentRow["environment"]) : undefined, like ? or(ilike(agents.name, like), ilike(agents.department, like), ilike(agents.description, like)) : undefined)).orderBy(agents.name).limit(2000);
        return agentSummaries(tx, org(ctx), rows);
      });
    },

    async getAgent(ctx: TenantContext, id: string) {
      await authorizer.require(ctx, "agent.read");
      const canPolicy = await authorizer.can(ctx, "agent.policy.read");
      const canAudit = await authorizer.can(ctx, "agent.audit.read");
      return tenant(ctx, async (tx) => {
        const a = await loadAgent(tx, org(ctx), id);
        const [summary] = await agentSummaries(tx, org(ctx), [a]);
        const identities = await tx.select().from(agentIdentities).where(eq(agentIdentities.agentId, id)).orderBy(desc(agentIdentities.createdAt));
        const bs = canPolicy ? await bindingsOf(tx, id) : [];
        const [risk] = await tx.select().from(agentRiskAssessments).where(eq(agentRiskAssessments.agentId, id)).orderBy(desc(agentRiskAssessments.computedAt)).limit(1);
        const reviews = await tx.select().from(agentReviews).where(eq(agentReviews.agentId, id)).orderBy(desc(agentReviews.dueAt)).limit(20);
        const incidents = await tx.select().from(agentIncidents).where(eq(agentIncidents.agentId, id)).orderBy(desc(agentIncidents.createdAt)).limit(20);
        const versions = await tx.select({ version: agentVersions.version, changeNote: agentVersions.changeNote, createdAt: agentVersions.createdAt }).from(agentVersions).where(eq(agentVersions.agentId, id)).orderBy(desc(agentVersions.version)).limit(30);
        const recent = canAudit ? await tx.select().from(agentActions).where(eq(agentActions.agentId, id)).orderBy(desc(agentActions.occurredAt)).limit(25) : [];
        const decisions = await tx.select({ effect: agentPolicyEvaluations.effect, n: sql<number>`count(*)::int` }).from(agentPolicyEvaluations).where(and(eq(agentPolicyEvaluations.agentId, id), sql`${agentPolicyEvaluations.source} <> 'simulation'`, gte(agentPolicyEvaluations.createdAt, new Date(Date.now() - 30 * 86400_000)))).groupBy(agentPolicyEvaluations.effect);
        return {
          ...summary!,
          identities: identities.map((i) => ({ id: i.id, kind: i.kind, status: i.status, apiKeyId: i.apiKeyId, hasSecret: !!i.secretRef, fingerprint: i.fingerprint, issuer: i.issuer, subject: i.subject, scopes: i.scopes, environment: i.environment, expiresAt: iso(i.expiresAt), lastUsedAt: iso(i.lastUsedAt), revokedAt: iso(i.revokedAt), createdAt: i.createdAt.toISOString() })),
          bindings: bs.map(bindingView),
          canSeeBindings: canPolicy,
          risk: risk ? { score: Number(risk.score), band: risk.band, components: risk.components, explanation: risk.explanation, modelVersion: risk.modelVersion, computedAt: risk.computedAt.toISOString() } : null,
          reviews: reviews.map((r) => ({ id: r.id, dueAt: r.dueAt.toISOString(), status: r.status, outcome: r.outcome, reviewOwnerUserId: r.reviewOwnerUserId, completedAt: iso(r.completedAt), notes: r.notes, purposeValid: r.purposeValid, permissionsValid: r.permissionsValid, systemsRequired: r.systemsRequired, riskStatus: r.riskStatus })),
          incidents: incidents.map((i) => ({ id: i.id, kind: i.kind, severity: i.severity, status: i.status, title: i.title, createdAt: i.createdAt.toISOString() })),
          versions: versions.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() })),
          recentActivity: recent.map(activityView),
          decisions30d: Object.fromEntries(decisions.map((d) => [d.effect, d.n])) as Record<string, number>,
        };
      });
    },

    async registerAgent(ctx: TenantContext, raw: unknown, opts: { discoveredVia?: "manual" | "api" | "integration"; status?: "pending" | "unknown" } = {}) {
      await authorizer.require(ctx, "agent.register");
      const input = parse(agentInputSchema, raw);
      const created = await tenant(ctx, async (tx) => {
        const [dup] = await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.organizationId, org(ctx)), eq(agents.name, input.name))).limit(1);
        if (dup) throw conflict(`An agent named "${input.name}" already exists.`);
        await assertMember(tx, org(ctx), input.ownerUserId, "Owner");
        const [a] = await tx.insert(agents).values({ ...input, organizationId: org(ctx), status: opts.status ?? "pending", discoveredVia: opts.discoveredVia ?? (ctx.actor.type === "user" ? "manual" : "api"), createdBy: userId(ctx) }).returning();
        await tx.insert(agentVersions).values({ organizationId: org(ctx), agentId: a!.id, version: 1, snapshot: await snapshot(tx, a!), changeNote: "Registered", createdBy: userId(ctx) });
        await record(ctx, "agent.registered", "agent", a!.id, { after: agentView(a!) });
        await bus.publish(ctx, "agent.registered", { agentId: a!.id, name: a!.name, status: a!.status, discoveredVia: a!.discoveredVia });
        return a!;
      });
      await computeRisk(org(ctx), created.id, userId(ctx));
      return agentView(created);
    },

    async updateAgent(ctx: TenantContext, id: string, raw: unknown) {
      await authorizer.require(ctx, "agent.manage");
      const { changeNote, ...input } = parse(agentUpdateSchema, raw);
      const view = await tenant(ctx, async (tx) => {
        const before = await loadAgent(tx, org(ctx), id);
        await assertMember(tx, org(ctx), input.ownerUserId, "Owner");
        await tx.update(agents).set({ ...input, updatedAt: new Date() }).where(eq(agents.id, id));
        const after = await newVersion(tx, ctx, id, changeNote ?? "Agent updated");
        await record(ctx, "agent.updated", "agent", id, { before: agentView(before), after: agentView(after) });
        return agentView(after);
      });
      await computeRisk(org(ctx), id, userId(ctx));
      return view;
    },

    /** Lifecycle: approve (pending/unknown/restricted → approved), restrict, retire, reinstate a suspended agent. */
    async setStatus(ctx: TenantContext, id: string, raw: unknown) {
      const input = parse(z.object({ status: z.enum(["approved", "restricted", "retired", "pending"]), note: text(1000).optional() }), raw);
      await authorizer.require(ctx, "agent.manage");
      return tenant(ctx, async (tx) => {
        const a = await loadAgent(tx, org(ctx), id);
        if (a.status === "suspended" || a.quarantined) await authorizer.require(ctx, "agent.suspend"); // lifting a kill switch is an emergency-grade action
        if (input.status === "approved" && a.status !== "approved") {
          if (a.createdBy && a.createdBy === userId(ctx)) throw forbidden("Separation of duties: the person who registered an agent cannot approve it.");
          if (!a.ownerUserId) throw new AppError("VALIDATION_FAILED", "Assign an owner before approving an agent.");
        }
        const [u] = await tx.update(agents).set({ status: input.status, quarantined: false, ...(input.status === "approved" ? { approvedBy: userId(ctx), approvedAt: new Date() } : {}), updatedAt: new Date() }).where(eq(agents.id, id)).returning();
        await newVersion(tx, ctx, id, `Status → ${input.status}${input.note ? `: ${input.note}` : ""}`);
        await record(ctx, `agent.${input.status === "approved" ? "approved" : "status_changed"}`, "agent", id, { before: { status: a.status, quarantined: a.quarantined }, after: { status: input.status }, metadata: { note: input.note } });
        if (input.status === "approved" && a.status !== "approved") {
          await bus.publish(ctx, "agent.approved", { agentId: id, approvedBy: userId(ctx) ?? ctx.actor.id });
          const [hasReview] = await tx.select({ id: agentReviews.id }).from(agentReviews).where(and(eq(agentReviews.agentId, id), eq(agentReviews.status, "scheduled"))).limit(1);
          if (!hasReview) {
            const risk = await computeRisk(org(ctx), id, userId(ctx));
            await scheduleReview(org(ctx), id, new Date(Date.now() + REVIEW_INTERVAL_DAYS[risk.band] * 86400_000), a.ownerUserId, a.ownerUserId);
          }
        }
        return agentView(u!);
      });
    },

    // ── Identities (shared credential system) ─────────────────────────────
    /** Issue a platform API key bound to the agent. The raw key is returned ONCE; only its hash exists (shared API key store). */
    async issueApiKey(ctx: TenantContext, agentId: string, raw: unknown) {
      await authorizer.require(ctx, "agent.manage");
      const input = parse(z.object({ scopes: z.array(z.string().max(120)).min(1).max(50), expiresInDays: z.number().int().min(1).max(730).default(90), environment: z.enum(ENVIRONMENTS).optional() }), raw);
      const a = await tenant(ctx, (tx) => loadAgent(tx, org(ctx), agentId));
      if (a.status === "retired") throw conflict("Retired agents cannot receive credentials.");
      // The shared API key service enforces delegation: apikey.manage, known scopes, and only scopes the issuer holds.
      const { key, apiKey } = await apiKeys.create(ctx, { name: `agent:${a.name}`.slice(0, 120), scopes: input.scopes, expiresInDays: input.expiresInDays });
      const [identity] = await tenant(ctx, (tx) =>
        tx.insert(agentIdentities).values({ organizationId: org(ctx), agentId, kind: "api_key", apiKeyId: apiKey.id, fingerprint: apiKey.prefix, scopes: apiKey.scopes, environment: input.environment ?? a.environment, expiresAt: apiKey.expiresAt ? new Date(apiKey.expiresAt) : null, createdBy: userId(ctx) }).returning(),
      );
      await record(ctx, "agent.credential_issued", "agent", agentId, { after: { identityId: identity!.id, apiKeyId: apiKey.id, prefix: apiKey.prefix, scopes: apiKey.scopes } });
      return { key, identityId: identity!.id, prefix: apiKey.prefix, expiresAt: apiKey.expiresAt };
    },

    /** Record an externally issued identity (OAuth client, certificate, IdP subject). Secrets go to the shared secret store; only a reference is kept. */
    async addExternalIdentity(ctx: TenantContext, agentId: string, raw: unknown) {
      await authorizer.require(ctx, "agent.manage");
      const input = parse(z.object({ kind: z.enum(["oauth_client", "certificate", "external"]), issuer: text(300).optional(), subject: text(300).min(1), fingerprint: text(200).optional(), scopes: z.array(text(200)).max(50).default([]), environment: z.enum(ENVIRONMENTS).optional(), expiresAt: z.coerce.date().optional(), secret: z.string().min(1).max(20_000).optional() }), raw);
      const a = await tenant(ctx, (tx) => loadAgent(tx, org(ctx), agentId));
      const secretRef = input.secret ? await secrets.put({ organizationId: org(ctx), name: `agent/${a.id}/${input.kind}`, value: input.secret }) : null;
      const [identity] = await tenant(ctx, (tx) =>
        tx.insert(agentIdentities).values({ organizationId: org(ctx), agentId, kind: input.kind, issuer: input.issuer ?? null, subject: input.subject, fingerprint: input.fingerprint ?? null, scopes: input.scopes, environment: input.environment ?? a.environment, expiresAt: input.expiresAt ?? null, secretRef, createdBy: userId(ctx) }).returning(),
      );
      await record(ctx, "agent.identity_added", "agent", agentId, { after: { identityId: identity!.id, kind: input.kind, issuer: input.issuer, subject: input.subject, fingerprint: input.fingerprint, hasSecret: !!secretRef } });
      return { identityId: identity!.id };
    },

    async revokeIdentity(ctx: TenantContext, identityId: string) {
      if (!(await authorizer.can(ctx, "agent.manage"))) await authorizer.require(ctx, "agent.suspend");
      uuidOr404(identityId, "Identity");
      const [i] = await tenant(ctx, (tx) => tx.select().from(agentIdentities).where(and(eq(agentIdentities.organizationId, org(ctx)), eq(agentIdentities.id, identityId))).limit(1));
      if (!i) throw notFound("Identity", identityId);
      await revokeIdentityRow(ctx, i);
      return { revoked: true };
    },

    // ── Permission bindings (least privilege) ─────────────────────────────
    async addBinding(ctx: TenantContext, agentId: string, raw: unknown) {
      await authorizer.require(ctx, "agent.policy.manage");
      const input = parse(bindingInputSchema, raw);
      if (input.conditions !== undefined && input.conditions !== null) {
        try {
          policyEngine.validate({ combining: "first-match", defaultEffect: "DENY", rules: [{ id: "c", effect: "ALLOW", when: input.conditions }] });
        } catch (err) {
          throw new AppError("VALIDATION_FAILED", `conditions: ${err instanceof Error ? err.message.slice(0, 300) : "invalid"}`);
        }
      }
      return tenant(ctx, async (tx) => {
        await loadAgent(tx, org(ctx), agentId);
        if (input.connectorId) {
          const [c] = await tx.select({ id: connectors.id, type: connectors.type }).from(connectors).where(and(eq(connectors.organizationId, org(ctx)), eq(connectors.id, input.connectorId))).limit(1);
          if (!c) throw new AppError("VALIDATION_FAILED", "Unknown connector.");
          if (input.system === "*") input.system = c.type;
        }
        const [b] = await tx.insert(agentPermissionBindings).values({ ...input, conditions: input.conditions ?? null, connectorId: input.connectorId ?? null, financialLimit: input.financialLimit ?? null, timeWindow: input.timeWindow ?? null, expiresAt: input.expiresAt ?? null, organizationId: org(ctx), agentId, createdBy: userId(ctx) }).returning();
        await newVersion(tx, ctx, agentId, `Binding added: ${input.actionType} ${input.system}/${input.resource}`);
        await record(ctx, "agent.binding_added", "agent", agentId, { after: bindingView(b!) });
        return bindingView(b!);
      }).then(async (v) => {
        await computeRisk(org(ctx), agentId, userId(ctx));
        return v;
      });
    },

    async setBindingStatus(ctx: TenantContext, bindingId: string, status: "active" | "disabled") {
      await authorizer.require(ctx, status === "disabled" && !(await authorizer.can(ctx, "agent.policy.manage")) ? "agent.suspend" : "agent.policy.manage");
      uuidOr404(bindingId, "Binding");
      const b = await tenant(ctx, async (tx) => {
        const [u] = await tx.update(agentPermissionBindings).set({ status, updatedAt: new Date() }).where(and(eq(agentPermissionBindings.organizationId, org(ctx)), eq(agentPermissionBindings.id, bindingId))).returning();
        if (!u) throw notFound("Binding", bindingId);
        await newVersion(tx, ctx, u.agentId, `Binding ${status}: ${u.actionType} ${u.system}/${u.resource}`);
        await record(ctx, `agent.binding_${status === "active" ? "enabled" : "disabled"}`, "agent", u.agentId, { metadata: { bindingId } });
        return u;
      });
      await computeRisk(org(ctx), b.agentId, userId(ctx));
      return bindingView(b);
    },

    /** Dry-run a request against an agent's bindings and policies (logged as a simulation). */
    async simulate(ctx: TenantContext, agentId: string, raw: unknown) {
      await authorizer.require(ctx, "agent.policy.read");
      const input = parse(actionRequestSchema, raw);
      const a = await tenant(ctx, (tx) => loadAgent(tx, org(ctx), agentId));
      return evaluate(ctx, a, { ...input, environment: input.environment ?? a.environment, connectorId: input.connectorId ?? null }, "simulation");
    },

    async listEvaluations(ctx: TenantContext, q: { agentId?: string; effect?: string; source?: string; limit?: number } = {}) {
      await authorizer.require(ctx, "agent.policy.read");
      return tenant(ctx, async (tx) => {
        const rows = await tx
          .select({ e: agentPolicyEvaluations, agentName: agents.name })
          .from(agentPolicyEvaluations)
          .innerJoin(agents, eq(agents.id, agentPolicyEvaluations.agentId))
          .where(and(eq(agentPolicyEvaluations.organizationId, org(ctx)), q.agentId && isUuid(q.agentId) ? eq(agentPolicyEvaluations.agentId, q.agentId) : undefined, q.effect ? eq(agentPolicyEvaluations.effect, q.effect as Effect) : undefined, q.source ? eq(agentPolicyEvaluations.source, q.source as "direct") : undefined))
          .orderBy(desc(agentPolicyEvaluations.createdAt))
          .limit(Math.min(500, q.limit ?? 200));
        return rows.map(({ e, agentName }) => ({ id: e.id, agentId: e.agentId, agentName, requestId: e.requestId, source: e.source, input: e.input, effect: e.effect, reasons: e.reasons, matchedBindings: e.matchedBindings, policies: e.policies, createdAt: e.createdAt.toISOString() }));
      });
    },

    // ── Agent runtime API (called by the agent identity) ──────────────────
    async startSession(ctx: TenantContext, raw: unknown) {
      const a = await selfAgent(ctx);
      if (a.status !== "approved" && a.status !== "restricted") throw forbidden(`Agent is ${a.quarantined ? "quarantined" : a.status}.`);
      const input = parse(z.object({ instruction: z.string().max(20_000).optional(), onBehalfOfUserId: z.string().uuid().optional(), externalRef: text(200).optional() }), raw);
      const full = await retainContent(org(ctx));
      const s = await orgScope(org(ctx), async (tx) => {
        await assertMember(tx, org(ctx), input.onBehalfOfUserId, "onBehalfOfUserId");
        const [row] = await tx.insert(agentSessions).values({ organizationId: org(ctx), agentId: a.id, externalRef: input.externalRef ?? null, onBehalfOfUserId: input.onBehalfOfUserId ?? null, instruction: input.instruction ? (full ? redactString(input.instruction).slice(0, 20_000) : "[not retained — metadata only]") : null }).returning();
        return row!;
      });
      if (input.instruction) await activity(org(ctx), a.id, { sessionId: s.id, kind: "instruction", source: "agent", summary: full ? input.instruction.slice(0, 200) : `Instruction received (${input.instruction.length} chars; content not retained)`, detail: { instruction: input.instruction } }, full);
      await jobs.enqueue(RETENTION_JOB, {}, { idempotencyKey: `retention:${new Date().toISOString().slice(0, 10)}` });
      return { sessionId: s.id };
    },

    async recordActivity(ctx: TenantContext, sessionId: string, raw: unknown) {
      const a = await selfAgent(ctx);
      const input = parse(z.object({ kind: z.enum(ACTIVITY_KINDS).refine((k) => !["policy_decision", "approval", "emergency"].includes(k), "This kind is recorded by the platform"), summary: text(300).min(1), system: text(120).optional(), resource: text(300).optional(), actionType: z.enum(ACTION_TYPES).optional(), detail: z.unknown().optional() }), raw);
      uuidOr404(sessionId, "Session");
      const [s] = await orgScope(org(ctx), (tx) => tx.select().from(agentSessions).where(and(eq(agentSessions.id, sessionId), eq(agentSessions.agentId, a.id))).limit(1));
      if (!s) throw notFound("Session", sessionId);
      if (s.status !== "active") throw conflict("The session has ended.");
      await activity(org(ctx), a.id, { sessionId, kind: input.kind, source: "agent", system: input.system, resource: input.resource, actionType: input.actionType, summary: input.summary, detail: input.detail });
      return { recorded: true };
    },

    async endSession(ctx: TenantContext, sessionId: string, raw: unknown) {
      const a = await selfAgent(ctx);
      const input = parse(z.object({ status: z.enum(["completed", "failed"]).default("completed"), output: z.unknown().optional() }), raw);
      uuidOr404(sessionId, "Session");
      const [s] = await orgScope(org(ctx), (tx) => tx.update(agentSessions).set({ status: input.status, endedAt: new Date() }).where(and(eq(agentSessions.id, sessionId), eq(agentSessions.agentId, a.id), eq(agentSessions.status, "active"))).returning());
      if (!s) throw notFound("Active session", sessionId);
      if (input.output !== undefined) await activity(org(ctx), a.id, { sessionId, kind: "output", source: "agent", summary: "Session output", detail: input.output });
      return { ended: true };
    },

    /** Runtime control: the agent asks before acting. Evaluated, logged, and approval-gated. */
    async requestAction(ctx: TenantContext, raw: unknown) {
      const a = await selfAgent(ctx);
      const input = parse(actionRequestSchema, raw);
      if (input.idempotencyKey) {
        const [dup] = await orgScope(org(ctx), (tx) => tx.select().from(agentActionRequests).where(and(eq(agentActionRequests.agentId, a.id), eq(agentActionRequests.idempotencyKey, input.idempotencyKey!))).limit(1));
        if (dup) {
          const [ap] = await orgScope(org(ctx), (tx) => tx.select({ id: agentApprovals.id }).from(agentApprovals).where(eq(agentApprovals.requestId, dup.id)).limit(1));
          return { ...requestView(dup, a.name), approvalId: ap?.id ?? null, duplicate: true };
        }
      }
      let session: typeof agentSessions.$inferSelect | undefined;
      if (input.sessionId) {
        [session] = await orgScope(org(ctx), (tx) => tx.select().from(agentSessions).where(and(eq(agentSessions.id, input.sessionId!), eq(agentSessions.agentId, a.id))).limit(1));
        if (!session) throw notFound("Session", input.sessionId);
      }
      const req: ActionRequestInput = { ...input, environment: input.environment ?? a.environment, connectorId: input.connectorId ?? null, context: { ...input.context, onBehalfOfUserId: session?.onBehalfOfUserId ?? null } };
      const decision = await evaluate(ctx, a, req, "direct");
      const status: RequestStatus = decision.effect === "ALLOW" ? "allowed" : decision.effect === "DENY" ? "denied" : decision.effect === "ESCALATE" ? "escalated" : "pending_approval";
      const full = await retainContent(org(ctx));
      const row = await orgScope(org(ctx), async (tx) => {
        const [r] = await tx.insert(agentActionRequests).values({
          organizationId: org(ctx), agentId: a.id, sessionId: input.sessionId ?? null, actionType: input.actionType, action: input.action, system: input.system, connectorId: input.connectorId ?? null,
          resource: input.resource, environment: req.environment, dataSensitivity: input.dataSensitivity, amount: input.amount ?? null, currency: input.currency ?? null,
          context: full ? (redactDeep(input.context) as Record<string, unknown>) : {}, decision: decision.effect, status, reasons: decision.reasons, bindingId: decision.bindingId, idempotencyKey: input.idempotencyKey ?? null,
        }).returning();
        await tx.update(agentPolicyEvaluations).set({ requestId: r!.id }).where(eq(agentPolicyEvaluations.id, decision.evaluationId));
        return r!;
      });
      await activity(org(ctx), a.id, { sessionId: input.sessionId, requestId: row.id, kind: "action_proposed", source: "agent", system: input.system, resource: input.resource, actionType: input.actionType, summary: `${input.action} (${input.actionType}) on ${input.system}/${input.resource}${input.amount != null ? ` · ${input.amount} ${input.currency ?? ""}` : ""}`, detail: { justification: input.justification, context: input.context } }, full);
      await activity(org(ctx), a.id, { sessionId: input.sessionId, requestId: row.id, kind: "policy_decision", system: input.system, resource: input.resource, actionType: input.actionType, decision: decision.effect, summary: `${decision.effect}: ${decision.reasons[0] ?? ""}`, detail: { reasons: decision.reasons, policies: decision.policies, matchedBindings: decision.matchedBindingIds } }, true);
      await record(ctx, "agent.action_requested", "agent_action_request", row.id, { outcome: decision.effect === "DENY" ? "denied" : "success", metadata: { agentId: a.id, action: input.action, actionType: input.actionType, system: input.system, decision: decision.effect } });
      await bus.publish(ctx, "agent.action.requested", { requestId: row.id, agentId: a.id, actionType: input.actionType, action: input.action, system: input.system, decision: decision.effect });
      await usage.record(ctx, { moduleId: MODULE_ID, metric: "agent.action_requests", unit: "request", quantity: 1, agentId: a.id, dimensions: { decision: decision.effect, actionType: input.actionType } });
      if (decision.effect === "ALLOW") await bus.publish(ctx, "agent.action.allowed", { requestId: row.id, agentId: a.id, source: "direct" });
      if (decision.effect === "DENY") await bus.publish(ctx, "agent.action.denied", { requestId: row.id, agentId: a.id, source: "direct", reason: decision.reasons[0] ?? "denied" });
      let approvalId: string | null = null;
      if (decision.effect === "REQUIRE_APPROVAL" || decision.effect === "ESCALATE") {
        const expiresAt = new Date(Date.now() + 48 * 3600_000);
        const [ap] = await orgScope(org(ctx), (tx) =>
          tx.insert(agentApprovals).values({
            organizationId: org(ctx), requestId: row.id, agentId: a.id, status: decision.effect === "ESCALATE" ? "escalated" : "pending", escalationLevel: decision.effect === "ESCALATE" ? 1 : 0,
            reason: input.justification ?? decision.reasons[0] ?? "Policy requires approval.", affectedSystems: [input.system, ...(input.connectorId ? [`connector:${input.connectorId}`] : [])],
            affectedRecords: input.affectedRecords ? redactDeep(input.affectedRecords) : [input.resource], financialImpact: input.amount ?? null, dataSensitivity: input.dataSensitivity,
            policy: { effect: decision.effect, reasons: decision.reasons, policies: decision.policies, bindingId: decision.bindingId }, supportingContext: full ? redactDeep({ context: input.context, justification: input.justification }) : { retained: false },
            expiresAt,
          }).returning(),
        );
        approvalId = ap!.id;
        await jobs.enqueue(APPROVAL_EXPIRE_JOB, { approvalId: ap!.id }, { organizationId: org(ctx), runAt: expiresAt, idempotencyKey: `agent-approval:${ap!.id}` });
        await bus.publish(ctx, "agent.approval.required", { approvalId: ap!.id, requestId: row.id, agentId: a.id, escalated: decision.effect === "ESCALATE" });
        await notifications.notify(ctx, {
          type: "agent.approval_required", title: `${a.name} requests approval: ${input.action}`, body: `${input.actionType} on ${input.system}/${input.resource}${input.amount != null ? ` · ${input.amount} ${input.currency ?? ""}` : ""}`,
          actionUrl: `${BASE}/approvals?focus=${ap!.id}`, priority: "high", recipients: { permission: decision.effect === "ESCALATE" ? "agent.manage" : "agent.approval.review" },
        });
      }
      return { ...requestView(row, a.name), approvalId, duplicate: false };
    },

    async getRequest(ctx: TenantContext, id: string) {
      uuidOr404(id, "Request");
      if (ctx.actor.type !== "agent") await authorizer.require(ctx, "agent.action.read");
      const [row] = await orgScope(org(ctx), (tx) => tx.select({ r: agentActionRequests, name: agents.name }).from(agentActionRequests).innerJoin(agents, eq(agents.id, agentActionRequests.agentId)).where(and(eq(agentActionRequests.organizationId, org(ctx)), eq(agentActionRequests.id, id))).limit(1));
      if (!row || (ctx.actor.type === "agent" && row.r.agentId !== ctx.actor.id)) throw notFound("Request", id);
      const [ap] = await orgScope(org(ctx), (tx) => tx.select().from(agentApprovals).where(eq(agentApprovals.requestId, id)).limit(1));
      return { ...requestView(row.r, row.name), approval: ap ? approvalView(ap, { agentName: row.name }) : null };
    },

    async reportResult(ctx: TenantContext, id: string, raw: unknown) {
      const a = await selfAgent(ctx);
      const input = parse(z.object({ status: z.enum(["executed", "failed"]), result: z.unknown().optional(), error: text(2000).optional() }), raw);
      uuidOr404(id, "Request");
      const row = await orgScope(org(ctx), async (tx) => {
        const [r] = await tx.select().from(agentActionRequests).where(and(eq(agentActionRequests.id, id), eq(agentActionRequests.agentId, a.id))).limit(1);
        if (!r) throw notFound("Request", id);
        if (r.status !== "allowed" && r.status !== "approved") throw conflict(`Only allowed or approved requests can be executed (this one is ${r.status}).`);
        const [u] = await tx.update(agentActionRequests).set({ status: input.status, result: input.result === undefined ? null : redactDeep(input.result), executedAt: new Date(), updatedAt: new Date() }).where(eq(agentActionRequests.id, id)).returning();
        return u!;
      });
      await activity(org(ctx), a.id, { sessionId: row.sessionId, requestId: id, kind: input.status === "executed" ? "action_executed" : "error", source: "agent", system: row.system, resource: row.resource, actionType: row.actionType, summary: input.status === "executed" ? `Executed ${row.action}` : `Failed ${row.action}: ${input.error ?? "error"}`, detail: input.result ?? { error: input.error } });
      await record(ctx, `agent.action_${input.status}`, "agent_action_request", id, { outcome: input.status === "executed" ? "success" : "failure", metadata: { agentId: a.id, action: row.action } });
      return requestView(row, a.name);
    },

    async respondToClarification(ctx: TenantContext, requestId: string, raw: unknown) {
      const a = await selfAgent(ctx);
      const input = parse(z.object({ message: text(4000).min(1) }), raw);
      uuidOr404(requestId, "Request");
      const ap = await orgScope(org(ctx), async (tx) => {
        const [x] = await tx.select().from(agentApprovals).where(and(eq(agentApprovals.requestId, requestId), eq(agentApprovals.agentId, a.id))).limit(1);
        if (!x) throw notFound("Approval", requestId);
        if (x.status !== "clarification_requested") throw conflict("No clarification was requested.");
        const entry: ConversationEntry = { at: new Date().toISOString(), by: a.name, role: "agent", kind: "clarification", message: redactString(input.message) };
        const [u] = await tx.update(agentApprovals).set({ status: x.escalationLevel > 0 ? "escalated" : "pending", conversation: [...x.conversation, entry], updatedAt: new Date() }).where(eq(agentApprovals.id, x.id)).returning();
        await tx.update(agentActionRequests).set({ status: x.escalationLevel > 0 ? "escalated" : "pending_approval", updatedAt: new Date() }).where(eq(agentActionRequests.id, requestId));
        return u!;
      });
      await activity(org(ctx), a.id, { requestId, kind: "approval", source: "agent", summary: "Clarification provided", detail: { message: input.message } });
      await notifications.notify(ctx, { type: "agent.approval_required", title: `${a.name} answered your question`, body: input.message.slice(0, 300), actionUrl: `${BASE}/approvals?focus=${ap.id}`, recipients: { permission: "agent.approval.review" } });
      return approvalView(ap, { agentName: a.name });
    },

    // ── Approvals (humans) ────────────────────────────────────────────────
    async listApprovals(ctx: TenantContext, q: { status?: string } = {}) {
      await authorizer.require(ctx, "agent.approval.review");
      return tenant(ctx, async (tx) => {
        const rows = await tx
          .select({ ap: agentApprovals, r: agentActionRequests, name: agents.name })
          .from(agentApprovals)
          .innerJoin(agentActionRequests, eq(agentActionRequests.id, agentApprovals.requestId))
          .innerJoin(agents, eq(agents.id, agentApprovals.agentId))
          .where(and(eq(agentApprovals.organizationId, org(ctx)), q.status ? eq(agentApprovals.status, q.status as ApprovalRow["status"]) : undefined))
          .orderBy(desc(agentApprovals.createdAt))
          .limit(500);
        return rows.map(({ ap, r, name }) => approvalView(ap, { agentName: name, request: requestView(r, name) }));
      });
    },

    async decideApproval(ctx: TenantContext, id: string, raw: unknown) {
      await authorizer.require(ctx, "agent.approval.review");
      if (ctx.actor.type !== "user") throw forbidden("Approvals are decided by people.");
      const input = parse(decisionSchema, raw);
      uuidOr404(id, "Approval");
      const res = await tenant(ctx, async (tx) => {
        const [ap] = await tx.select().from(agentApprovals).where(and(eq(agentApprovals.organizationId, org(ctx)), eq(agentApprovals.id, id))).limit(1);
        if (!ap) throw notFound("Approval", id);
        if (!["pending", "escalated", "clarification_requested"].includes(ap.status)) throw conflict(`This approval is already ${ap.status.replace("_", " ")}.`);
        if (ap.expiresAt.getTime() <= Date.now()) throw conflict("This approval has expired.");
        const [r] = await tx.select().from(agentActionRequests).where(eq(agentActionRequests.id, ap.requestId)).limit(1);
        const [s] = r?.sessionId ? await tx.select().from(agentSessions).where(eq(agentSessions.id, r.sessionId)).limit(1) : [];
        // Separation of duties: the person the agent acts for never approves its request.
        if (s?.onBehalfOfUserId && s.onBehalfOfUserId === ctx.actor.id) {
          await audit.recordDetached(ctx, { module: MODULE_ID, action: "agent.approval_decided", resourceType: "agent_approval", resourceId: id, outcome: "denied", metadata: { reason: "separation_of_duties" } });
          throw forbidden("Separation of duties: the agent acts on your behalf in this session, so someone else must decide.");
        }
        // Escalated approvals need a higher authority.
        if (ap.escalationLevel > 0 && (input.decision === "approve" || input.decision === "reject")) await authorizer.require(ctx, "agent.manage");
        const [agent] = await tx.select().from(agents).where(eq(agents.id, ap.agentId)).limit(1);
        if (input.decision === "approve" && (agent!.status === "suspended" || agent!.quarantined || agent!.status === "retired")) throw conflict(`The agent is ${agent!.quarantined ? "quarantined" : agent!.status}; its requests cannot be approved.`);
        const entry: ConversationEntry = { at: new Date().toISOString(), by: ctx.actor.label, role: "approver", kind: input.decision === "request_clarification" ? "clarification_request" : input.decision === "escalate" ? "escalation" : "decision", message: input.note ?? input.decision };
        const next = { approve: "approved", reject: "rejected", request_clarification: "clarification_requested", escalate: "escalated" }[input.decision] as ApprovalRow["status"];
        const terminal = input.decision === "approve" || input.decision === "reject";
        const [u] = await tx.update(agentApprovals).set({ status: next, conversation: [...ap.conversation, entry], ...(input.decision === "escalate" ? { escalationLevel: ap.escalationLevel + 1 } : {}), ...(terminal ? { decidedBy: ctx.actor.id, decidedAt: new Date(), decisionNote: input.note ?? null } : {}), updatedAt: new Date() }).where(eq(agentApprovals.id, id)).returning();
        const reqStatus: RequestStatus = { approve: "approved", reject: "rejected", request_clarification: "clarification_requested", escalate: "escalated" }[input.decision] as RequestStatus;
        await tx.update(agentActionRequests).set({ status: reqStatus, updatedAt: new Date() }).where(eq(agentActionRequests.id, ap.requestId));
        await record(ctx, "agent.approval_decided", "agent_approval", id, { after: { decision: input.decision, note: input.note, escalationLevel: u!.escalationLevel }, metadata: { requestId: ap.requestId, agentId: ap.agentId } });
        return { ap: u!, agent: agent!, request: r! };
      });
      await activity(org(ctx), res.ap.agentId, { sessionId: res.request.sessionId, requestId: res.request.id, kind: "approval", decision: input.decision, summary: `${ctx.actor.label}: ${input.decision.replace("_", " ")}${input.note ? ` — ${input.note.slice(0, 120)}` : ""}` }, true);
      if (input.decision === "approve") await bus.publish(ctx, "agent.action.allowed", { requestId: res.request.id, agentId: res.ap.agentId, source: "approval" });
      if (input.decision === "reject") await bus.publish(ctx, "agent.action.denied", { requestId: res.request.id, agentId: res.ap.agentId, source: "approval", reason: input.note ?? "rejected" });
      if (input.decision === "escalate") await notifications.notify(ctx, { type: "agent.approval_required", title: `Escalated: ${res.agent.name} — ${res.request.action}`, body: input.note ?? "", actionUrl: `${BASE}/approvals?focus=${id}`, priority: "high", recipients: { permission: "agent.manage" } });
      return approvalView(res.ap, { agentName: res.agent.name, request: requestView(res.request, res.agent.name) });
    },

    // ── Kill switch ───────────────────────────────────────────────────────
    async emergency(ctx: TenantContext, agentId: string, raw: unknown) {
      await authorizer.require(ctx, "agent.suspend");
      const input = parse(emergencySchema, raw);
      const a = await tenant(ctx, (tx) => loadAgent(tx, org(ctx), agentId));
      if (input.confirm.trim() !== a.name) throw new AppError("VALIDATION_FAILED", `Type the agent's name ("${a.name}") to confirm.`);
      const taken: Array<{ action: string; detail?: string }> = [];
      const stopAgent = async (quarantine: boolean) => {
        await tenant(ctx, async (tx) => {
          await tx.update(agents).set({ status: "suspended", quarantined: quarantine || a.quarantined, updatedAt: new Date() }).where(eq(agents.id, agentId));
          const cancelled = await tx.update(agentApprovals).set({ status: "cancelled", decisionNote: "Agent stopped by kill switch.", updatedAt: new Date() }).where(and(eq(agentApprovals.agentId, agentId), inArray(agentApprovals.status, ["pending", "escalated", "clarification_requested"]))).returning({ requestId: agentApprovals.requestId });
          if (cancelled.length) await tx.update(agentActionRequests).set({ status: "cancelled", updatedAt: new Date() }).where(inArray(agentActionRequests.id, cancelled.map((c) => c.requestId)));
          await tx.update(agentActionRequests).set({ status: "cancelled", updatedAt: new Date() }).where(and(eq(agentActionRequests.agentId, agentId), eq(agentActionRequests.status, "allowed")));
          await tx.update(agentSessions).set({ status: "terminated", endedAt: new Date() }).where(and(eq(agentSessions.agentId, agentId), eq(agentSessions.status, "active")));
          await newVersion(tx, ctx, agentId, `${quarantine ? "Quarantined" : "Suspended"}: ${input.reason}`);
          taken.push({ action: quarantine ? "quarantine" : "suspend", detail: `${cancelled.length} pending approval(s) cancelled; active sessions terminated; un-executed allowed requests cancelled` });
        });
      };
      const revokeAll = async () => {
        const ids = await tenant(ctx, (tx) => tx.select().from(agentIdentities).where(and(eq(agentIdentities.agentId, agentId), eq(agentIdentities.status, "active"))));
        for (const i of ids) await revokeIdentityRow(ctx, i);
        taken.push({ action: "revoke_credentials", detail: `${ids.length} credential(s) revoked` });
      };
      switch (input.action) {
        case "suspend":
          await stopAgent(false);
          break;
        case "quarantine": {
          await stopAgent(true);
          await revokeAll();
          const disabled = await tenant(ctx, (tx) => tx.update(agentPermissionBindings).set({ status: "disabled", updatedAt: new Date() }).where(and(eq(agentPermissionBindings.agentId, agentId), eq(agentPermissionBindings.status, "active"))).returning({ id: agentPermissionBindings.id }));
          taken.push({ action: "disable_capability", detail: `${disabled.length} binding(s) disabled` });
          break;
        }
        case "revoke_credentials":
          await revokeAll();
          break;
        case "disable_capability": {
          if (!input.bindingId) throw new AppError("VALIDATION_FAILED", "bindingId is required.");
          const [b] = await tenant(ctx, (tx) => tx.update(agentPermissionBindings).set({ status: "disabled", updatedAt: new Date() }).where(and(eq(agentPermissionBindings.agentId, agentId), eq(agentPermissionBindings.id, input.bindingId!))).returning());
          if (!b) throw notFound("Binding", input.bindingId);
          taken.push({ action: "disable_capability", detail: `${b.actionType} ${b.system}/${b.resource} disabled` });
          break;
        }
        case "block_connector": {
          if (!input.connectorId) throw new AppError("VALIDATION_FAILED", "connectorId is required.");
          const [c] = await tenant(ctx, (tx) => tx.select({ id: connectors.id, name: connectors.name }).from(connectors).where(and(eq(connectors.organizationId, org(ctx)), eq(connectors.id, input.connectorId!))).limit(1));
          if (!c) throw notFound("Connector", input.connectorId);
          await tenant(ctx, (tx) => tx.update(agents).set({ blockedConnectorIds: [...new Set([...a.blockedConnectorIds, c.id])], updatedAt: new Date() }).where(eq(agents.id, agentId)));
          taken.push({ action: "block_connector", detail: `Connector "${c.name}" blocked` });
          break;
        }
      }
      await record(ctx, `agent.emergency_${input.action}`, "agent", agentId, { metadata: { reason: input.reason, actions: taken } });
      await activity(org(ctx), agentId, { kind: "emergency", decision: input.action, summary: `Kill switch: ${input.action.replace("_", " ")} by ${ctx.actor.label} — ${input.reason.slice(0, 120)}`, detail: { actions: taken } }, true);
      if (input.action === "suspend" || input.action === "quarantine") await bus.publish(ctx, "agent.suspended", { agentId, action: input.action, reason: input.reason });
      const incident = await openIncident(ctx, agentId, { kind: "kill_switch", severity: input.action === "quarantine" ? "critical" : "high", title: `Kill switch: ${input.action.replace("_", " ")} — ${a.name}`, description: input.reason, actions: taken });
      if (a.ownerUserId) await notifications.notify(ctx, { type: "agent.emergency", title: `Your agent ${a.name}: ${input.action.replace("_", " ")}`, body: input.reason, actionUrl: `${BASE}/agents/${agentId}`, priority: "critical", recipients: { userIds: [a.ownerUserId] } });
      await computeRisk(org(ctx), agentId, userId(ctx));
      return { actions: taken, incidentId: incident.id };
    },

    // ── Incidents ─────────────────────────────────────────────────────────
    async listIncidents(ctx: TenantContext, q: { status?: string; agentId?: string } = {}) {
      await authorizer.require(ctx, "agent.read");
      return tenant(ctx, async (tx) => {
        const rows = await tx.select({ i: agentIncidents, name: agents.name }).from(agentIncidents).innerJoin(agents, eq(agents.id, agentIncidents.agentId)).where(and(eq(agentIncidents.organizationId, org(ctx)), q.status ? eq(agentIncidents.status, q.status as "open") : undefined, q.agentId && isUuid(q.agentId) ? eq(agentIncidents.agentId, q.agentId) : undefined)).orderBy(desc(agentIncidents.createdAt)).limit(500);
        return rows.map(({ i, name }) => ({ id: i.id, agentId: i.agentId, agentName: name, kind: i.kind, severity: i.severity, status: i.status, title: i.title, description: i.description, actionsTaken: i.actionsTaken, relatedRequestId: i.relatedRequestId, resolution: i.resolution, resolvedAt: iso(i.resolvedAt), createdAt: i.createdAt.toISOString() }));
      });
    },

    async createIncident(ctx: TenantContext, agentId: string, raw: unknown) {
      await authorizer.require(ctx, "agent.incident.manage");
      const input = parse(z.object({ severity: z.enum(RISK_LEVELS), title: text(200).min(3), description: text(4000).default(""), requestId: z.string().uuid().optional() }), raw);
      await tenant(ctx, (tx) => loadAgent(tx, org(ctx), agentId));
      const i = await openIncident(ctx, agentId, { kind: "manual", severity: input.severity, title: input.title, description: input.description, requestId: input.requestId });
      return { id: i.id };
    },

    async updateIncident(ctx: TenantContext, id: string, raw: unknown) {
      await authorizer.require(ctx, "agent.incident.manage");
      const input = parse(z.object({ status: z.enum(["open", "investigating", "resolved"]), resolution: text(4000).optional() }), raw);
      uuidOr404(id, "Incident");
      return tenant(ctx, async (tx) => {
        const [u] = await tx.update(agentIncidents).set({ status: input.status, ...(input.status === "resolved" ? { resolvedBy: userId(ctx), resolvedAt: new Date(), resolution: input.resolution ?? null } : {}) }).where(and(eq(agentIncidents.organizationId, org(ctx)), eq(agentIncidents.id, id))).returning();
        if (!u) throw notFound("Incident", id);
        await record(ctx, "agent.incident_updated", "agent_incident", id, { after: input });
        return { id: u.id, status: u.status };
      });
    },

    // ── Activity & replay ─────────────────────────────────────────────────
    async listSessions(ctx: TenantContext, q: { agentId?: string; userId?: string; system?: string; action?: string; decision?: string; from?: string; to?: string; incidentId?: string } = {}) {
      await authorizer.require(ctx, "agent.audit.read");
      return tenant(ctx, async (tx) => {
        let window: { agentId: string; from: Date; to: Date } | null = null;
        if (q.incidentId && isUuid(q.incidentId)) {
          const [i] = await tx.select().from(agentIncidents).where(and(eq(agentIncidents.organizationId, org(ctx)), eq(agentIncidents.id, q.incidentId))).limit(1);
          if (i) window = { agentId: i.agentId, from: new Date(i.createdAt.getTime() - 24 * 3600_000), to: new Date(i.createdAt.getTime() + 3600_000) };
        }
        const conds = [eq(agentSessions.organizationId, org(ctx))];
        const agentFilter = window?.agentId ?? (q.agentId && isUuid(q.agentId) ? q.agentId : null);
        if (agentFilter) conds.push(eq(agentSessions.agentId, agentFilter));
        if (q.userId && isUuid(q.userId)) conds.push(eq(agentSessions.onBehalfOfUserId, q.userId));
        const from = window?.from ?? (q.from ? new Date(q.from) : null);
        const to = window?.to ?? (q.to ? new Date(q.to) : null);
        if (from && !Number.isNaN(from.getTime())) conds.push(gte(agentSessions.lastEventAt, from));
        if (to && !Number.isNaN(to.getTime())) conds.push(lte(agentSessions.startedAt, to));
        const actFilter = [q.system ? sql`a.system ilike ${q.system}` : null, q.action ? sql`a.action_type = ${q.action}` : null, q.decision ? sql`a.decision = ${q.decision}` : null].filter(Boolean);
        if (actFilter.length) conds.push(sql`exists (select 1 from agent_actions a where a.session_id = ${agentSessions.id} and ${sql.join(actFilter as ReturnType<typeof sql>[], sql` and `)})`);
        const rows = await tx
          .select({ s: agentSessions, agentName: agents.name, userName: users.name, events: sql<number>`(select count(*)::int from agent_actions a where a.session_id = ${agentSessions.id})`, denied: sql<number>`(select count(*)::int from agent_actions a where a.session_id = ${agentSessions.id} and a.decision = 'DENY')` })
          .from(agentSessions)
          .innerJoin(agents, eq(agents.id, agentSessions.agentId))
          .leftJoin(users, eq(users.id, agentSessions.onBehalfOfUserId))
          .where(and(...conds))
          .orderBy(desc(agentSessions.startedAt))
          .limit(300);
        return rows.map(({ s, agentName, userName, events, denied }) => ({ id: s.id, agentId: s.agentId, agentName, onBehalfOf: userName, status: s.status, startedAt: s.startedAt.toISOString(), endedAt: iso(s.endedAt), events, denied, instruction: s.instruction }));
      });
    },

    async getSession(ctx: TenantContext, id: string) {
      await authorizer.require(ctx, "agent.audit.read");
      uuidOr404(id, "Session");
      return tenant(ctx, async (tx) => {
        const [row] = await tx.select({ s: agentSessions, agentName: agents.name, userName: users.name }).from(agentSessions).innerJoin(agents, eq(agents.id, agentSessions.agentId)).leftJoin(users, eq(users.id, agentSessions.onBehalfOfUserId)).where(and(eq(agentSessions.organizationId, org(ctx)), eq(agentSessions.id, id))).limit(1);
        if (!row) throw notFound("Session", id);
        const steps = await tx.select().from(agentActions).where(eq(agentActions.sessionId, id)).orderBy(agentActions.occurredAt);
        const requests = await tx.select().from(agentActionRequests).where(eq(agentActionRequests.sessionId, id)).orderBy(agentActionRequests.createdAt);
        return { id: row.s.id, agentId: row.s.agentId, agentName: row.agentName, onBehalfOf: row.userName, status: row.s.status, instruction: row.s.instruction, startedAt: row.s.startedAt.toISOString(), endedAt: iso(row.s.endedAt), steps: steps.map(activityView), requests: requests.map((r) => requestView(r, row.agentName)) };
      });
    },

    async listActivity(ctx: TenantContext, q: { agentId?: string; kind?: string; decision?: string; limit?: number } = {}) {
      await authorizer.require(ctx, "agent.action.read");
      return tenant(ctx, async (tx) => {
        const rows = await tx.select({ a: agentActions, name: agents.name }).from(agentActions).innerJoin(agents, eq(agents.id, agentActions.agentId)).where(and(eq(agentActions.organizationId, org(ctx)), q.agentId && isUuid(q.agentId) ? eq(agentActions.agentId, q.agentId) : undefined, q.kind ? eq(agentActions.kind, q.kind as ActivityKind) : undefined, q.decision ? eq(agentActions.decision, q.decision) : undefined)).orderBy(desc(agentActions.occurredAt)).limit(Math.min(500, q.limit ?? 200));
        return rows.map(({ a, name }) => ({ ...activityView(a), agentName: name }));
      });
    },

    async listRequests(ctx: TenantContext, q: { agentId?: string; status?: string } = {}) {
      await authorizer.require(ctx, "agent.action.read");
      return tenant(ctx, async (tx) => {
        const rows = await tx.select({ r: agentActionRequests, name: agents.name }).from(agentActionRequests).innerJoin(agents, eq(agents.id, agentActionRequests.agentId)).where(and(eq(agentActionRequests.organizationId, org(ctx)), q.agentId && isUuid(q.agentId) ? eq(agentActionRequests.agentId, q.agentId) : undefined, q.status ? eq(agentActionRequests.status, q.status as RequestStatus) : undefined)).orderBy(desc(agentActionRequests.createdAt)).limit(500);
        return rows.map(({ r, name }) => requestView(r, name));
      });
    },

    // ── Risk, dashboard, reviews ──────────────────────────────────────────
    async recomputeRisk(ctx: TenantContext, agentId: string) {
      await authorizer.require(ctx, "agent.read");
      await tenant(ctx, (tx) => loadAgent(tx, org(ctx), agentId));
      return computeRisk(org(ctx), agentId, userId(ctx));
    },

    async dashboard(ctx: TenantContext): Promise<DashboardView> {
      await authorizer.require(ctx, "agent.read");
      return tenant(ctx, async (tx) => {
        const all = await tx.select().from(agents).where(eq(agents.organizationId, org(ctx)));
        const summaries = await agentSummaries(tx, org(ctx), all);
        const since = new Date(Date.now() - 30 * 86400_000);
        const decisions = await tx.select({ effect: agentPolicyEvaluations.effect, n: sql<number>`count(*)::int` }).from(agentPolicyEvaluations).where(and(eq(agentPolicyEvaluations.organizationId, org(ctx)), sql`${agentPolicyEvaluations.source} <> 'simulation'`, gte(agentPolicyEvaluations.createdAt, since))).groupBy(agentPolicyEvaluations.effect);
        const [sensitive] = await tx.select({ n: sql<number>`count(*)::int` }).from(agentActionRequests).where(and(eq(agentActionRequests.organizationId, org(ctx)), inArray(agentActionRequests.dataSensitivity, ["confidential", "restricted"]), gte(agentActionRequests.createdAt, since)));
        const [pending] = await tx.select({ n: sql<number>`count(*)::int` }).from(agentApprovals).where(and(eq(agentApprovals.organizationId, org(ctx)), inArray(agentApprovals.status, ["pending", "escalated", "clarification_requested"])));
        const [violations] = await tx.select({ n: sql<number>`count(*)::int` }).from(agentIncidents).where(and(eq(agentIncidents.organizationId, org(ctx)), eq(agentIncidents.kind, "policy_violation"), gte(agentIncidents.createdAt, since)));
        const [stale] = await tx.select({ n: sql<number>`count(distinct ${agentReviews.agentId})::int` }).from(agentReviews).where(and(eq(agentReviews.organizationId, org(ctx)), eq(agentReviews.status, "scheduled"), lte(agentReviews.dueAt, new Date())));
        const [openInc] = await tx.select({ n: sql<number>`count(*)::int` }).from(agentIncidents).where(and(eq(agentIncidents.organizationId, org(ctx)), sql`${agentIncidents.status} <> 'resolved'`));
        const live = all.filter((a) => a.status !== "retired");
        const denied = decisions.find((d) => d.effect === "DENY")?.n ?? 0;
        const now = Date.now();
        const attention = summaries
          .filter((s) => s.status !== "retired")
          .map((s) => ({
            agentId: s.id, name: s.name,
            reasons: [
              s.status === "unknown" ? "Unknown (discovered, not registered)" : null,
              !s.ownerUserId ? "No owner" : null,
              s.riskBand === "high" || s.riskBand === "critical" ? `${s.riskBand} risk (${s.riskScore})` : null,
              s.nextReviewAt && Date.parse(s.nextReviewAt) < now ? "Review overdue" : null,
              s.openIncidents ? `${s.openIncidents} open incident(s)` : null,
              s.quarantined ? "Quarantined" : s.status === "suspended" ? "Suspended" : null,
            ].filter((x): x is string => !!x),
          }))
          .filter((x) => x.reasons.length)
          .slice(0, 20);
        return {
          activeAgents: all.filter((a) => (a.status === "approved" || a.status === "restricted") && !a.quarantined).length,
          unknownAgents: all.filter((a) => a.status === "unknown").length,
          highRiskAgents: summaries.filter((s) => s.status !== "retired" && (s.riskBand === "high" || s.riskBand === "critical" || s.riskCategory === "high" || s.riskCategory === "critical")).length,
          suspendedAgents: all.filter((a) => a.status === "suspended").length,
          privilegedAgents: summaries.filter((s) => s.status !== "retired" && s.privileged).length,
          policyViolations30d: (violations?.n ?? 0) + denied,
          deniedActions30d: denied,
          pendingApprovals: pending?.n ?? 0,
          sensitiveDataAccess30d: sensitive?.n ?? 0,
          agentsWithoutOwners: live.filter((a) => !a.ownerUserId).length,
          staleReviews: stale?.n ?? 0,
          openIncidents: openInc?.n ?? 0,
          byStatus: AGENT_STATUSES.map((st) => ({ label: st, value: all.filter((a) => a.status === st).length })),
          decisions30d: ["ALLOW", "REQUIRE_APPROVAL", "ESCALATE", "DENY"].map((e) => ({ label: e, value: decisions.find((d) => d.effect === e)?.n ?? 0 })),
          attention,
        };
      });
    },

    async listReviews(ctx: TenantContext, q: { status?: string } = {}) {
      await authorizer.require(ctx, "agent.read");
      return tenant(ctx, async (tx) => {
        const rows = await tx.select({ r: agentReviews, name: agents.name, owner: users.name }).from(agentReviews).innerJoin(agents, eq(agents.id, agentReviews.agentId)).leftJoin(users, eq(users.id, agentReviews.reviewOwnerUserId)).where(and(eq(agentReviews.organizationId, org(ctx)), q.status ? eq(agentReviews.status, q.status as "scheduled") : undefined)).orderBy(agentReviews.dueAt).limit(500);
        return rows.map(({ r, name, owner }) => ({ id: r.id, agentId: r.agentId, agentName: name, reviewOwnerUserId: r.reviewOwnerUserId, reviewOwnerName: owner, dueAt: r.dueAt.toISOString(), overdue: r.status === "scheduled" && r.dueAt.getTime() < Date.now(), status: r.status, outcome: r.outcome, purposeValid: r.purposeValid, permissionsValid: r.permissionsValid, systemsRequired: r.systemsRequired, riskStatus: r.riskStatus, notes: r.notes, completedAt: iso(r.completedAt) }));
      });
    },

    async scheduleReview(ctx: TenantContext, agentId: string, raw: unknown) {
      await authorizer.require(ctx, "agent.manage");
      const input = parse(z.object({ dueAt: z.coerce.date(), reviewOwnerUserId: z.string().uuid().optional() }), raw);
      const a = await tenant(ctx, async (tx) => {
        const x = await loadAgent(tx, org(ctx), agentId);
        await assertMember(tx, org(ctx), input.reviewOwnerUserId, "Review owner");
        return x;
      });
      const r = await scheduleReview(org(ctx), agentId, input.dueAt, a.ownerUserId, input.reviewOwnerUserId ?? a.ownerUserId);
      await record(ctx, "agent.review_scheduled", "agent_review", r.id, { after: { agentId, dueAt: input.dueAt.toISOString(), reviewOwner: r.reviewOwnerUserId } });
      return { id: r.id };
    },

    async completeReview(ctx: TenantContext, reviewId: string, raw: unknown) {
      const input = parse(reviewCompleteSchema, raw);
      uuidOr404(reviewId, "Review");
      const [rv] = await tenant(ctx, (tx) => tx.select().from(agentReviews).where(and(eq(agentReviews.organizationId, org(ctx)), eq(agentReviews.id, reviewId))).limit(1));
      if (!rv) throw notFound("Review", reviewId);
      if (rv.reviewOwnerUserId !== userId(ctx)) await authorizer.require(ctx, "agent.manage");
      else await authorizer.require(ctx, "agent.read");
      if (rv.status !== "scheduled") throw conflict("This review is already closed.");
      const a = await tenant(ctx, async (tx) => {
        await tx.update(agentReviews).set({ ...input, status: "completed", completedBy: userId(ctx), completedAt: new Date() }).where(eq(agentReviews.id, reviewId));
        const statusFor = { approved: null, changes_required: null, restricted: "restricted", retired: "retired" } as const;
        const st = statusFor[input.outcome];
        const [u] = await tx.update(agents).set({ lastReviewAt: new Date(), ...(st ? { status: st } : {}), updatedAt: new Date() }).where(eq(agents.id, rv.agentId)).returning();
        if (st) await newVersion(tx, ctx, rv.agentId, `Review outcome: ${input.outcome}`);
        await record(ctx, "agent.review_completed", "agent_review", reviewId, { after: input, metadata: { agentId: rv.agentId } });
        return u!;
      });
      if (input.outcome !== "retired") {
        const risk = await computeRisk(org(ctx), a.id, userId(ctx));
        await scheduleReview(org(ctx), a.id, new Date(Date.now() + REVIEW_INTERVAL_DAYS[risk.band] * 86400_000), a.ownerUserId, rv.reviewOwnerUserId);
      }
      return { completed: true };
    },

    // ── Internal hooks (wired in index.ts) ────────────────────────────────
    /** API key → agent actor (shared auth extension point). */
    async bindApiKey(key: { id: string; organizationId: string; name: string; scopes: string[] }) {
      const [row] = await orgScope(key.organizationId, (tx) =>
        tx.select({ i: agentIdentities, a: agents }).from(agentIdentities).innerJoin(agents, eq(agents.id, agentIdentities.agentId)).where(and(eq(agentIdentities.apiKeyId, key.id), eq(agentIdentities.organizationId, key.organizationId))).limit(1),
      );
      if (!row) return null;
      if (row.i.status !== "active") throw new Error("agent identity revoked"); // fail closed
      if (!row.i.lastUsedAt || Date.now() - row.i.lastUsedAt.getTime() > 60_000) await orgScope(key.organizationId, (tx) => tx.update(agentIdentities).set({ lastUsedAt: new Date() }).where(eq(agentIdentities.id, row.i.id)));
      return { type: "agent" as const, id: row.a.id, label: `agent:${row.a.name}`, scopes: key.scopes };
    },

    /** Permissions of an agent actor: its credential's scopes, only while the agent may operate. */
    async resolveAgentPermissions(ctx: TenantContext) {
      if (!isUuid(ctx.actor.id)) return { orgWide: [] };
      const [a] = await orgScope(ctx.organizationId, (tx) => tx.select().from(agents).where(and(eq(agents.organizationId, ctx.organizationId), eq(agents.id, ctx.actor.id))).limit(1));
      if (!a || a.quarantined || (a.status !== "approved" && a.status !== "restricted")) return { orgWide: [] };
      return { orgWide: (ctx.actor.scopes ?? []).filter((s) => permissions.has(s)) };
    },

    /** Agent enforcement inside Integration's shared policy evaluation ("integration_action" interceptor). */
    async interceptIntegration(ctx: TenantContext, req: PolicyInput) {
      if (ctx.actor.type !== "agent") return null;
      const a = await orgScope(ctx.organizationId, (tx) => loadAgent(tx, ctx.organizationId, ctx.actor.id)).catch(() => null);
      if (!a) return { effect: "DENY" as const, reasons: ["Unknown agent identity."] };
      const attrs = (req.resource.attributes ?? {}) as Record<string, unknown>;
      const input = ((req.context ?? {}) as Record<string, unknown>).input as Record<string, unknown> | undefined;
      const amount = typeof input?.amount === "number" ? input.amount : null;
      const r: ActionRequestInput = {
        actionType: actionTypeForOperation(String(attrs.operation ?? "execute")), action: req.resource.id ?? "integration.action", system: String(attrs.connectorType ?? "*"),
        connectorId: typeof attrs.connectorId === "string" ? attrs.connectorId : null, resource: req.resource.id ?? "*", environment: a.environment,
        dataSensitivity: (["public", "internal", "confidential", "restricted"].includes(String(attrs.dataSensitivity)) ? attrs.dataSensitivity : "internal") as ActionRequestInput["dataSensitivity"],
        amount, context: { trigger: (req.context as Record<string, unknown>)?.trigger, mode: (req.context as Record<string, unknown>)?.mode },
      };
      const d = await evaluate(ctx, a, r, "integration");
      await activity(ctx.organizationId, a.id, { kind: "tool_call", source: "integration", system: r.system, resource: r.resource, actionType: r.actionType, decision: d.effect, summary: `Integration tool ${r.resource} → ${d.effect}`, detail: { reasons: d.reasons } });
      if (d.effect === "DENY") await bus.publish(ctx, "agent.action.denied", { requestId: null, agentId: a.id, source: "integration", reason: d.reasons[0] ?? "denied" });
      else if (d.effect === "ALLOW") await bus.publish(ctx, "agent.action.allowed", { requestId: null, agentId: a.id, source: "integration" });
      return { effect: d.effect, reasons: d.reasons };
    },

    /** Unknown-agent discovery from unverified agent claims seen by the Integration tool gateway. */
    async discoverFromClaim(orgId: string, claim: { id: string; name?: string }, source: "integration") {
      const [exists] = await orgScope(orgId, (tx) => tx.select({ id: agents.id }).from(agents).where(and(eq(agents.organizationId, orgId), or(eq(agents.externalId, claim.id), eq(agents.name, claim.name ?? claim.id)))).limit(1));
      if (exists) return null;
      const ctx: TenantContext = { organizationId: orgId, actor: SYSTEM_ACTOR("agent_governance"), correlationId: `discover:${claim.id}`, cache: new Map() };
      try {
        return await service.registerAgent(ctx, { name: (claim.name ?? claim.id).slice(0, 120), externalId: claim.id, description: "Discovered from an unverified agent claim on the AI tool gateway." }, { discoveredVia: source, status: "unknown" });
      } catch (err) {
        logger.warn("agent_governance.discovery_failed", { error: err instanceof Error ? err.message : String(err) });
        return null;
      }
    },

    async expireApproval(orgId: string, approvalId: string) {
      await orgScope(orgId, async (tx) => {
        const [ap] = await tx.update(agentApprovals).set({ status: "expired", decisionNote: "Expired without a decision.", updatedAt: new Date() }).where(and(eq(agentApprovals.id, approvalId), inArray(agentApprovals.status, ["pending", "escalated", "clarification_requested"]), lte(agentApprovals.expiresAt, new Date()))).returning();
        if (ap) await tx.update(agentActionRequests).set({ status: "expired", updatedAt: new Date() }).where(eq(agentActionRequests.id, ap.requestId));
      });
    },

    async remindReview(orgId: string, reviewId: string) {
      const [r] = await orgScope(orgId, (tx) => tx.select({ r: agentReviews, name: agents.name }).from(agentReviews).innerJoin(agents, eq(agents.id, agentReviews.agentId)).where(eq(agentReviews.id, reviewId)).limit(1));
      if (!r || r.r.status !== "scheduled") return;
      const ctx: TenantContext = { organizationId: orgId, actor: SYSTEM_ACTOR("agent_governance"), correlationId: `review:${reviewId}`, cache: new Map() };
      await notifications.notify(ctx, {
        type: "agent.review_due", title: `Agent review due: ${r.name}`, body: `Attest that ${r.name}'s purpose, permissions and systems are still valid by ${r.r.dueAt.toISOString().slice(0, 10)}.`,
        actionUrl: `${BASE}/reviews?focus=${reviewId}`, recipients: r.r.reviewOwnerUserId ? { userIds: [r.r.reviewOwnerUserId] } : { permission: "agent.manage" },
      });
    },

    /** Daily purge of activity older than each organization's AI retention window. */
    async applyRetention() {
      await db.withSystem("agent_governance.retention", async (tx) => {
        await tx.execute(sql`delete from agent_actions a using organization_settings s where s.organization_id = a.organization_id and a.occurred_at < now() - make_interval(days => coalesce((s.data_retention->>'aiRunDays')::int, 365))`);
        await tx.execute(sql`delete from agent_sessions x using organization_settings s where s.organization_id = x.organization_id and x.status <> 'active' and x.last_event_at < now() - make_interval(days => coalesce((s.data_retention->>'aiRunDays')::int, 365))`);
      });
    },
  };

  async function revokeIdentityRow(ctx: TenantContext, i: typeof agentIdentities.$inferSelect) {
    if (i.status !== "active") return;
    // Emergency-grade: the shared API key and secret are revoked as the governance system component after the caller was authorized.
    if (i.apiKeyId) await apiKeys.revoke(systemCtx(ctx), i.apiKeyId).catch((err: unknown) => logger.warn("agent_governance.api_key_revoke_failed", { error: err instanceof Error ? err.message : String(err) }));
    if (i.secretRef) await secrets.destroy(i.secretRef, ctx.organizationId).catch(() => undefined);
    await tenant(ctx, (tx) => tx.update(agentIdentities).set({ status: "revoked", revokedAt: new Date(), revokedBy: userId(ctx), secretRef: null }).where(eq(agentIdentities.id, i.id)));
    await record(ctx, "agent.credential_revoked", "agent", i.agentId, { metadata: { identityId: i.id, kind: i.kind, apiKeyId: i.apiKeyId } });
  }

  return service;
}

