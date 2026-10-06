import { z } from "zod";
import { type AuditService } from "@eaop/audit";
import { type ConnectorService } from "@eaop/connectors";
import { and, connectors, desc, eq, gte, ilike, inArray, lt, or, scopeOf, sql, users, type Database, type Tx } from "@eaop/db";
import { type EventBus, type EventRegistry } from "@eaop/events";
import { type JobQueue } from "@eaop/jobs";
import { type Authorizer, type PermissionRegistry } from "@eaop/rbac";
import { AppError, conflict, decodeCursor, encodeCursor, forbidden, isUuid, notFound, type Page, type TenantContext } from "@eaop/shared-types";
import { MODULE_ID, RUN_JOB, storedActor, type Engine } from "./engine";
import { graphSchema, validateGraph, type GraphIssue } from "./graph";
import { applyMappings, FIELD_TYPES, mappingsSchema, TRANSFORMS } from "./mapping";
import { breakerState, ERROR_CLASSES, type BreakerState } from "./reliability";
import { SAMPLE_ACTIONS, SAMPLE_EDGES, SAMPLE_INPUT_SCHEMA, SAMPLE_NODES } from "./samples";
import {
  BRIDGE_TYPES, EDGE_KINDS, NODE_TYPES, integrationActions, integrationApprovalBindings, integrationEdges, integrationErrors, integrationExecutions, integrationExecutionSteps, integrationNodes,
  integrationTransformations, integrationWorkflows, integrationWorkflowVersions, RISK_LEVELS, TERMINAL_STATUSES, TRIGGER_TYPES, type EdgeDef, type ExecutionState, type NodeDef,
  type Risk, type WorkflowSnapshot,
} from "./schema";
import { ACTION_TEMPLATES, templateByKey, type ActionTemplate } from "./templates";
import { parseJsonSchema, toolDefinition, validate, type JsonSchema } from "./validation";

const RISK_ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const maxRisk = (a: Risk, b: Risk): Risk => (RISK_ORDER[a] >= RISK_ORDER[b] ? a : b);

/** Validate input; failures become VALIDATION_FAILED with field-level issues. */
function parse<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.output<S> {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  throw new AppError("VALIDATION_FAILED", r.error.issues[0] ? `${r.error.issues[0].path.join(".") || "input"}: ${r.error.issues[0].message}` : "Request validation failed.", {
    issues: r.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })),
  });
}
const schemaParse = (raw: unknown, field: string): JsonSchema => {
  try {
    return parseJsonSchema(raw);
  } catch (err) {
    throw new AppError("VALIDATION_FAILED", `${field}: ${err instanceof Error ? err.message.slice(0, 300) : "invalid schema"}`);
  }
};

// ── Input schemas ───────────────────────────────────────────────────────────

const actionKey = z.string().regex(/^[a-z][a-z0-9_.-]{1,80}$/, "keys are lowercase letters, digits, . _ -");
const retrySchema = z.object({ maxAttempts: z.number().int().min(1).max(10), backoffSeconds: z.number().int().min(1).max(3600) });
const compensationSchema = z.object({ actionKey, inputTemplate: z.record(z.unknown()) }).nullable();

export const installTemplateSchema = z.object({
  templateKey: z.string().max(80),
  connectorId: z.string().uuid(),
  key: actionKey.optional(),
  name: z.string().trim().min(1).max(160).optional(),
  requiresApproval: z.boolean().optional(),
  risk: z.enum(RISK_LEVELS).optional(),
  aiExposed: z.boolean().default(false),
  timeoutMs: z.number().int().min(1000).max(120_000).optional(),
  rateLimitPerMinute: z.number().int().min(1).max(10_000).nullish(),
  retry: retrySchema.optional(),
  compensation: compensationSchema.optional(),
});

const HEADER_DENY = /^(authorization|cookie|host|content-length|connection|proxy-.*|x-forwarded-.*|transfer-encoding|te|upgrade)$/i;
export const customActionSchema = z.object({
  key: actionKey,
  name: z.string().trim().min(1).max(160),
  description: z.string().max(2000).default(""),
  connectorId: z.string().uuid(),
  bridgeType: z.enum(BRIDGE_TYPES).default("api_wrapper"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().min(1).max(1000).startsWith("/"),
  query: z.record(z.string().max(1000)).default({}),
  body: z.unknown().optional(),
  headers: z.record(z.string().max(1000)).default({}).refine((h) => Object.keys(h).every((k) => /^[A-Za-z0-9-]{1,64}$/.test(k) && !HEADER_DENY.test(k)), "headers may not set authorization, cookies, host or hop-by-hop headers — credentials come from the connector"),
  inputSchema: z.unknown(),
  outputSchema: z.unknown().optional(),
  risk: z.enum(RISK_LEVELS).default("medium"),
  requiresApproval: z.boolean().default(false),
  idempotency: z.enum(["none", "auto", "key_required"]).default("none"),
  timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
  rateLimitPerMinute: z.number().int().min(1).max(10_000).nullish(),
  retry: retrySchema.default({ maxAttempts: 3, backoffSeconds: 10 }),
  requiredPermissions: z.array(z.string().max(120)).max(10).default([]),
  aiExposed: z.boolean().default(false),
  capturePayloads: z.boolean().default(false),
  compensation: compensationSchema.optional(),
});

export const updateActionSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().max(2000).optional(),
  risk: z.enum(RISK_LEVELS).optional(),
  requiresApproval: z.boolean().optional(),
  aiExposed: z.boolean().optional(),
  capturePayloads: z.boolean().optional(),
  timeoutMs: z.number().int().min(1000).max(120_000).optional(),
  rateLimitPerMinute: z.number().int().min(1).max(10_000).nullish(),
  retry: retrySchema.optional(),
  idempotency: z.enum(["none", "auto", "key_required"]).optional(),
  requiredPermissions: z.array(z.string().max(120)).max(10).optional(),
  compensation: compensationSchema.optional(),
  status: z.enum(["active", "disabled"]).optional(),
});

export const transformationSchema = z.object({ name: z.string().trim().min(1).max(160), description: z.string().max(2000).default(""), mappings: mappingsSchema });

export const workflowCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(4000).default(""),
  triggerType: z.enum(TRIGGER_TYPES).default("manual"),
  triggerConfig: z.object({ eventType: z.string().max(120).optional() }).default({}),
  inputSchema: z.unknown().optional(),
});
export const workflowUpdateSchema = workflowCreateSchema.partial();
export const saveGraphSchema = graphSchema.extend({ changeNote: z.string().max(500).optional() });

export const startSchema = z.object({
  input: z.record(z.unknown()).default({}),
  mode: z.enum(["live", "test"]).default("live"),
  idempotencyKey: z.string().min(8).max(200).optional(),
  /** Run inline and return the result (bounded); otherwise the worker runs it. */
  wait: z.boolean().default(false),
});

export const invokeToolSchema = z.object({
  input: z.record(z.unknown()).default({}),
  /** Agent claim for callers authenticated by API key; verified for "agent" actors. */
  agent: z.object({ id: z.string().min(1).max(120), name: z.string().max(200).optional() }).optional(),
  idempotencyKey: z.string().min(8).max(200).optional(),
  mode: z.enum(["live", "test"]).default("live"),
});

export const decisionSchema = z.object({ decision: z.enum(["approve", "reject"]), note: z.string().max(2000).optional() });

// ── Views ───────────────────────────────────────────────────────────────────

type ActionRow = typeof integrationActions.$inferSelect;
type WorkflowRow = typeof integrationWorkflows.$inferSelect;
type ExecutionRow = typeof integrationExecutions.$inferSelect;
type ApprovalRow = typeof integrationApprovalBindings.$inferSelect;

export interface ActionView {
  id: string;
  key: string;
  name: string;
  description: string;
  connectorId: string;
  connectorName: string;
  connectorType: string;
  capability: string;
  operation: string;
  kind: "catalog" | "custom";
  templateKey: string | null;
  bridgeType: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema | null;
  requestTemplate: Record<string, unknown>;
  requiredPermissions: string[];
  risk: Risk;
  requiresApproval: boolean;
  idempotency: string;
  timeoutMs: number;
  rateLimitPerMinute: number | null;
  retry: { maxAttempts: number; backoffSeconds: number };
  compensation: { actionKey: string; inputTemplate: Record<string, unknown> } | null;
  capturePayloads: boolean;
  aiExposed: boolean;
  status: string;
  updatedAt: string;
}

export interface WorkflowView {
  id: string;
  name: string;
  description: string;
  status: string;
  triggerType: string;
  triggerConfig: Record<string, unknown>;
  inputSchema: JsonSchema | null;
  isSample: boolean;
  currentVersion: number;
  publishedVersion: number | null;
  updatedAt: string;
  createdAt: string;
}

export interface WorkflowDetail extends WorkflowView {
  nodes: NodeDef[];
  edges: EdgeDef[];
  issues: GraphIssue[];
  versions: Array<{ version: number; changeNote: string | null; createdAt: string; published: boolean }>;
  recentExecutions: ExecutionSummary[];
}

export interface ExecutionSummary {
  id: string;
  workflowId: string | null;
  workflowName: string | null;
  actionKey: string | null;
  workflowVersion: number | null;
  mode: string;
  trigger: string;
  status: string;
  actor: { type: string; id: string; label: string };
  agent: { id: string; name?: string } | null;
  currentNode: string | null;
  errorClass: string | null;
  errorMessage: string | null;
  systemCalls: number;
  aiCostUsd: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface ExecutionDetail extends ExecutionSummary {
  input: unknown;
  output: unknown;
  steps: Array<{
    seq: number; nodeKey: string; nodeType: string; attempt: number; status: string; input: unknown; output: unknown; systemCall: unknown; aiRunId: string | null;
    policyDecision: unknown; errorClass: string | null; errorMessage: string | null; costUsd: number; startedAt: string; durationMs: number | null;
  }>;
  approvals: ApprovalView[];
  errors: ErrorView[];
  nodes: NodeDef[] | null;
  edges: EdgeDef[] | null;
}

export interface ApprovalView {
  id: string;
  executionId: string;
  nodeKey: string;
  status: string;
  title: string;
  system: string | null;
  reason: string;
  risk: string;
  businessImpact: string | null;
  affectedData: unknown;
  proposedPayload: unknown;
  policyDecision: unknown;
  requestedBy: { type: string; id: string; label: string };
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  expiresAt: string;
  createdAt: string;
  workflowName: string | null;
}

export interface ErrorView {
  id: string;
  executionId: string | null;
  nodeKey: string | null;
  connectorId: string | null;
  actionId: string | null;
  errorClass: string;
  message: string;
  retryable: boolean;
  attempts: number;
  status: string;
  createdAt: string;
}

export interface OverviewView {
  executions7d: Record<string, number>;
  successRate7d: number | null;
  avgDurationMs7d: number | null;
  pendingApprovals: number;
  deadLetters: number;
  openErrors: number;
  activeWorkflows: number;
  actions: number;
  breakers: Array<{ connectorId: string; connectorName: string; state: BreakerState["state"]; recentFailures: number; retryAfterSeconds: number }>;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const userId = (ctx: TenantContext) => (ctx.actor.type === "user" ? ctx.actor.id : null);

const actionView = (a: ActionRow, c: { name: string; type: string }): ActionView => ({
  id: a.id, key: a.key, name: a.name, description: a.description, connectorId: a.connectorId, connectorName: c.name, connectorType: c.type, capability: a.capability, operation: a.operation,
  kind: a.kind, templateKey: a.templateKey, bridgeType: a.bridgeType, inputSchema: a.inputSchema as unknown as JsonSchema, outputSchema: (a.outputSchema as unknown as JsonSchema) ?? null,
  requestTemplate: a.requestTemplate, requiredPermissions: a.requiredPermissions, risk: a.risk, requiresApproval: a.requiresApproval, idempotency: a.idempotency, timeoutMs: a.timeoutMs,
  rateLimitPerMinute: a.rateLimitPerMinute, retry: a.retry, compensation: a.compensation ?? null, capturePayloads: a.capturePayloads, aiExposed: a.aiExposed, status: a.status, updatedAt: a.updatedAt.toISOString(),
});

const workflowView = (w: WorkflowRow): WorkflowView => ({
  id: w.id, name: w.name, description: w.description, status: w.status, triggerType: w.triggerType, triggerConfig: w.triggerConfig, inputSchema: (w.inputSchema as unknown as JsonSchema) ?? null,
  isSample: w.isSample, currentVersion: w.currentVersion, publishedVersion: w.publishedVersion, updatedAt: w.updatedAt.toISOString(), createdAt: w.createdAt.toISOString(),
});

const summary = (e: ExecutionRow, workflowName: string | null, actionKey: string | null): ExecutionSummary => ({
  id: e.id, workflowId: e.workflowId, workflowName, actionKey, workflowVersion: e.workflowVersion, mode: e.mode, trigger: e.trigger, status: e.status,
  actor: { type: e.actor.type, id: e.actor.id, label: e.actor.label }, agent: e.agent ?? null, currentNode: e.currentNode, errorClass: e.errorClass, errorMessage: e.errorMessage,
  systemCalls: e.systemCalls, aiCostUsd: Number(e.aiCostUsd), createdAt: e.createdAt.toISOString(), startedAt: iso(e.startedAt), finishedAt: iso(e.finishedAt), durationMs: e.durationMs,
});

const approvalView = (a: ApprovalRow, workflowName: string | null = null): ApprovalView => ({
  id: a.id, executionId: a.executionId, nodeKey: a.nodeKey, status: a.status, title: a.title, system: a.system, reason: a.reason, risk: a.risk, businessImpact: a.businessImpact,
  affectedData: a.affectedData, proposedPayload: a.proposedPayload, policyDecision: a.policyDecision, requestedBy: { type: a.requestedBy.type, id: a.requestedBy.id, label: a.requestedBy.label },
  decidedBy: a.decidedBy, decidedAt: iso(a.decidedAt), decisionNote: a.decisionNote, expiresAt: a.expiresAt.toISOString(), createdAt: a.createdAt.toISOString(), workflowName,
});

const errorView = (e: typeof integrationErrors.$inferSelect): ErrorView => ({
  id: e.id, executionId: e.executionId, nodeKey: e.nodeKey, connectorId: e.connectorId, actionId: e.actionId, errorClass: e.errorClass, message: e.message, retryable: e.retryable,
  attempts: e.attempts, status: e.status, createdAt: e.createdAt.toISOString(),
});

export interface IntegrationServiceDeps {
  db: Database;
  authorizer: Authorizer;
  audit: AuditService;
  bus: EventBus;
  connectors: ConnectorService;
  jobs: JobQueue;
  permissions: PermissionRegistry;
  eventRegistry: EventRegistry;
  engine: Engine;
}

export type IntegrationService = ReturnType<typeof createIntegrationService>;

export function createIntegrationService(deps: IntegrationServiceDeps) {
  const { db, authorizer, audit, bus, connectors: connectorService, jobs, permissions, eventRegistry, engine } = deps;
  const tenant = <T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>) => db.withTenant(scopeOf(ctx), fn);
  const org = (ctx: TenantContext) => ctx.organizationId;
  const record = (ctx: TenantContext, action: string, resourceType: string, resourceId: string, extra: { before?: unknown; after?: unknown; metadata?: Record<string, unknown>; outcome?: "success" | "failure" | "denied" } = {}) =>
    audit.record(ctx, { module: MODULE_ID, action, resourceType, resourceId, ...extra });
  const uuidOr404 = (id: string, what: string) => {
    if (!isUuid(id)) throw notFound(what, id);
  };

  async function connectorRow(ctx: TenantContext, id: string) {
    uuidOr404(id, "Connector");
    const [c] = await tenant(ctx, (tx) => tx.select().from(connectors).where(and(eq(connectors.organizationId, org(ctx)), eq(connectors.id, id))).limit(1));
    if (!c) throw notFound("Connector", id);
    return c;
  }

  function checkPermissions(keys: string[]) {
    for (const k of keys) if (!permissions.has(k)) throw new AppError("VALIDATION_FAILED", `Unknown permission "${k}".`);
    return keys.length ? keys : ["integration.execute"];
  }

  async function loadActionRow(tx: Tx, ctx: TenantContext, id: string) {
    uuidOr404(id, "Action");
    const [row] = await tx
      .select({ a: integrationActions, c: { name: connectors.name, type: connectors.type } })
      .from(integrationActions)
      .innerJoin(connectors, eq(connectors.id, integrationActions.connectorId))
      .where(and(eq(integrationActions.organizationId, org(ctx)), eq(integrationActions.id, id)))
      .limit(1);
    if (!row) throw notFound("Action", id);
    return row;
  }

  async function loadWorkflow(tx: Tx, ctx: TenantContext, id: string) {
    uuidOr404(id, "Workflow");
    const [w] = await tx.select().from(integrationWorkflows).where(and(eq(integrationWorkflows.organizationId, org(ctx)), eq(integrationWorkflows.id, id))).limit(1);
    if (!w) throw notFound("Workflow", id);
    return w;
  }

  async function graphOf(tx: Tx, ctx: TenantContext, workflowId: string) {
    const nodes = await tx.select().from(integrationNodes).where(and(eq(integrationNodes.organizationId, org(ctx)), eq(integrationNodes.workflowId, workflowId))).orderBy(integrationNodes.sort);
    const edges = await tx.select().from(integrationEdges).where(and(eq(integrationEdges.organizationId, org(ctx)), eq(integrationEdges.workflowId, workflowId)));
    return {
      nodes: nodes.map((n): NodeDef => ({ key: n.key, type: n.type, name: n.name, config: n.config, position: n.position })),
      edges: edges.map((e): EdgeDef => ({ from: e.fromKey, to: e.toKey, kind: e.kind, label: e.label })),
    };
  }

  async function activeActionKeys(tx: Tx, ctx: TenantContext) {
    const rows = await tx.select({ key: integrationActions.key }).from(integrationActions).where(and(eq(integrationActions.organizationId, org(ctx)), eq(integrationActions.status, "active")));
    return new Set(rows.map((r) => r.key));
  }

  async function snapshotOf(tx: Tx, ctx: TenantContext, w: WorkflowRow): Promise<WorkflowSnapshot> {
    const g = await graphOf(tx, ctx, w.id);
    return { name: w.name, description: w.description, triggerType: w.triggerType, triggerConfig: w.triggerConfig, inputSchema: (w.inputSchema as Record<string, unknown>) ?? null, ...g };
  }

  async function newVersion(tx: Tx, ctx: TenantContext, id: string, changeNote: string | null) {
    const [w] = await tx.update(integrationWorkflows).set({ currentVersion: sql`${integrationWorkflows.currentVersion} + 1`, updatedAt: new Date() }).where(eq(integrationWorkflows.id, id)).returning();
    await tx.insert(integrationWorkflowVersions).values({ organizationId: org(ctx), workflowId: id, version: w!.currentVersion, snapshot: await snapshotOf(tx, ctx, w!), changeNote, createdBy: userId(ctx) });
    return w!;
  }

  function validateTrigger(triggerType: string, cfg: { eventType?: string }) {
    if (triggerType !== "event") return {};
    if (!cfg.eventType) throw new AppError("VALIDATION_FAILED", "Event-triggered workflows need an event type.");
    if (cfg.eventType.startsWith("integration.")) throw new AppError("VALIDATION_FAILED", "Integration events cannot trigger integration workflows (prevents loops).");
    if (!eventRegistry.get(cfg.eventType)) throw new AppError("VALIDATION_FAILED", `Unknown event type "${cfg.eventType}".`);
    return { eventType: cfg.eventType };
  }

  async function createExecution(ctx: TenantContext, values: { workflowId?: string | null; workflowVersion?: number | null; actionId?: string | null; mode: "live" | "test"; trigger: "manual" | "api" | "event" | "gateway"; input: Record<string, unknown>; idempotencyKey?: string; agent?: { id: string; name?: string; verified?: boolean } | null }) {
    return tenant(ctx, async (tx) => {
      if (values.idempotencyKey) {
        const target = values.workflowId ?? values.actionId!;
        const [dup] = await tx
          .select()
          .from(integrationExecutions)
          .where(and(eq(integrationExecutions.organizationId, org(ctx)), sql`coalesce(${integrationExecutions.workflowId}, ${integrationExecutions.actionId}) = ${target}`, eq(integrationExecutions.idempotencyKey, values.idempotencyKey)))
          .limit(1);
        if (dup) return { row: dup, duplicate: true };
      }
      const [row] = await tx
        .insert(integrationExecutions)
        .values({
          organizationId: org(ctx), workflowId: values.workflowId ?? null, workflowVersion: values.workflowVersion ?? null, actionId: values.actionId ?? null, mode: values.mode, trigger: values.trigger,
          input: values.input, idempotencyKey: values.idempotencyKey ?? null, actor: storedActor(ctx), agent: values.agent ?? null, correlationId: ctx.correlationId, state: {},
        })
        .returning();
      await record(ctx, "integration.execution_requested", "integration_execution", row!.id, { metadata: { workflowId: values.workflowId, actionId: values.actionId, mode: values.mode, trigger: values.trigger, agent: values.agent?.id } });
      return { row: row!, duplicate: false };
    });
  }

  async function executionDetail(ctx: TenantContext, id: string): Promise<ExecutionDetail> {
    uuidOr404(id, "Execution");
    return tenant(ctx, async (tx) => {
      const [row] = await tx
        .select({ e: integrationExecutions, wfName: integrationWorkflows.name, actionKey: integrationActions.key })
        .from(integrationExecutions)
        .leftJoin(integrationWorkflows, eq(integrationWorkflows.id, integrationExecutions.workflowId))
        .leftJoin(integrationActions, eq(integrationActions.id, integrationExecutions.actionId))
        .where(and(eq(integrationExecutions.organizationId, org(ctx)), eq(integrationExecutions.id, id)))
        .limit(1);
      if (!row) throw notFound("Execution", id);
      const steps = await tx.select().from(integrationExecutionSteps).where(eq(integrationExecutionSteps.executionId, id)).orderBy(integrationExecutionSteps.seq);
      const approvals = await tx.select().from(integrationApprovalBindings).where(eq(integrationApprovalBindings.executionId, id));
      const errors = await tx.select().from(integrationErrors).where(eq(integrationErrors.executionId, id)).orderBy(integrationErrors.createdAt);
      let graph: { nodes: NodeDef[]; edges: EdgeDef[] } | null = null;
      if (row.e.workflowId && row.e.workflowVersion) {
        const [v] = await tx.select({ s: integrationWorkflowVersions.snapshot }).from(integrationWorkflowVersions).where(and(eq(integrationWorkflowVersions.workflowId, row.e.workflowId), eq(integrationWorkflowVersions.version, row.e.workflowVersion))).limit(1);
        if (v) graph = { nodes: v.s.nodes, edges: v.s.edges };
      }
      return {
        ...summary(row.e, row.wfName, row.actionKey),
        input: row.e.input,
        output: row.e.output ?? null,
        steps: steps.map((s) => ({
          seq: s.seq, nodeKey: s.nodeKey, nodeType: s.nodeType, attempt: s.attempt, status: s.status, input: s.input, output: s.output, systemCall: s.systemCall, aiRunId: s.aiRunId,
          policyDecision: s.policyDecision, errorClass: s.errorClass, errorMessage: s.errorMessage, costUsd: Number(s.costUsd), startedAt: s.startedAt.toISOString(), durationMs: s.durationMs,
        })),
        approvals: approvals.map((a) => approvalView(a, row.wfName)),
        errors: errors.map(errorView),
        nodes: graph?.nodes ?? null,
        edges: graph?.edges ?? null,
      };
    });
  }

  /** Enqueue (worker) or run inline (bounded) and return the latest view. */
  async function dispatch(ctx: TenantContext, ex: ExecutionRow, wait: boolean) {
    if (wait) await engine.run(ex.organizationId, ex.id);
    else await jobs.enqueue(RUN_JOB, { executionId: ex.id }, { organizationId: ex.organizationId, idempotencyKey: `${ex.id}:start`, correlationId: ctx.correlationId });
    return executionDetail(ctx, ex.id);
  }

  return {
    // ── Action catalog ────────────────────────────────────────────────────
    async templates(ctx: TenantContext) {
      await authorizer.require(ctx, "integration.read");
      const conns = await tenant(ctx, (tx) => tx.select({ id: connectors.id, name: connectors.name, type: connectors.type, status: connectors.status }).from(connectors).where(eq(connectors.organizationId, org(ctx))));
      const defs = new Map(connectorService.catalog().map((d) => [d.type, d]));
      return ACTION_TEMPLATES.filter((t) => defs.has(t.connectorType)).map((t) => ({
        ...t,
        connectorName: defs.get(t.connectorType)!.name,
        availability: defs.get(t.connectorType)!.availability,
        connectors: conns.filter((c) => c.type === t.connectorType && c.status !== "disabled").map((c) => ({ id: c.id, name: c.name })),
      }));
    },

    async listActions(ctx: TenantContext, q: { status?: string; q?: string } = {}) {
      await authorizer.require(ctx, "integration.read");
      return tenant(ctx, async (tx) => {
        const like = q.q ? `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
        const rows = await tx
          .select({ a: integrationActions, c: { name: connectors.name, type: connectors.type } })
          .from(integrationActions)
          .innerJoin(connectors, eq(connectors.id, integrationActions.connectorId))
          .where(and(eq(integrationActions.organizationId, org(ctx)), q.status ? eq(integrationActions.status, q.status as ActionRow["status"]) : undefined, like ? or(ilike(integrationActions.name, like), ilike(integrationActions.key, like)) : undefined))
          .orderBy(integrationActions.key);
        return rows.map((r) => actionView(r.a, r.c));
      });
    },

    async getAction(ctx: TenantContext, id: string) {
      await authorizer.require(ctx, "integration.read");
      return tenant(ctx, async (tx) => {
        const r = await loadActionRow(tx, ctx, id);
        return { ...actionView(r.a, r.c), tool: toolDefinition({ ...r.a, inputSchema: r.a.inputSchema as unknown as JsonSchema }) };
      });
    },

    async installTemplate(ctx: TenantContext, raw: unknown) {
      await authorizer.require(ctx, "integration.manage");
      const input = parse(installTemplateSchema, raw);
      const t = templateByKey(input.templateKey);
      if (!t) throw new AppError("VALIDATION_FAILED", `Unknown template "${input.templateKey}".`);
      return installTemplateInternal(ctx, t, input);
    },

    async createCustomAction(ctx: TenantContext, raw: unknown) {
      await authorizer.require(ctx, "integration.admin");
      const input = parse(customActionSchema, raw);
      const c = await connectorRow(ctx, input.connectorId);
      if (c.type !== "rest_api") throw new AppError("VALIDATION_FAILED", "Custom actions run through a shared REST API connector (its credentials are used — never stored on the action).");
      const inputSchema = schemaParse(input.inputSchema, "inputSchema");
      if (inputSchema.type !== "object") throw new AppError("VALIDATION_FAILED", "inputSchema must describe an object.");
      const outputSchema = input.outputSchema === undefined || input.outputSchema === null ? null : schemaParse(input.outputSchema, "outputSchema");
      const operation = input.method === "GET" ? "read" : input.method === "DELETE" ? "delete" : "write";
      // UI automation is the most fragile and least observable bridge: force high risk, approval and full payload capture.
      const ui = input.bridgeType === "ui_automation";
      const risk = ui ? maxRisk(input.risk, "high") : input.bridgeType === "rpa" ? maxRisk(input.risk, "medium") : input.risk;
      return tenant(ctx, async (tx) => {
        const [dup] = await tx.select({ id: integrationActions.id }).from(integrationActions).where(and(eq(integrationActions.organizationId, org(ctx)), eq(integrationActions.key, input.key))).limit(1);
        if (dup) throw conflict(`An action with key "${input.key}" already exists.`);
        const [a] = await tx
          .insert(integrationActions)
          .values({
            organizationId: org(ctx), key: input.key, name: input.name, description: input.description, connectorId: c.id, capability: "http.request", operation, kind: "custom", bridgeType: input.bridgeType,
            inputSchema: inputSchema as unknown as Record<string, unknown>, outputSchema: outputSchema as unknown as Record<string, unknown> | null,
            requestTemplate: { method: input.method, path: input.path, query: input.query, ...(input.body !== undefined ? { body: input.body } : {}), headers: input.headers },
            requiredPermissions: checkPermissions(input.requiredPermissions), risk, requiresApproval: ui || input.requiresApproval, idempotency: input.idempotency, timeoutMs: input.timeoutMs,
            rateLimitPerMinute: input.rateLimitPerMinute ?? null, retry: input.retry, compensation: input.compensation ?? null, capturePayloads: ui || input.capturePayloads, aiExposed: input.aiExposed, createdBy: userId(ctx),
          })
          .returning();
        await record(ctx, "integration.action_created", "integration_action", a!.id, { after: { key: a!.key, kind: "custom", bridgeType: a!.bridgeType, risk, method: input.method, path: input.path } });
        return actionView(a!, c);
      });
    },

    async updateAction(ctx: TenantContext, id: string, raw: unknown) {
      await authorizer.require(ctx, "integration.manage");
      const input = parse(updateActionSchema, raw);
      return tenant(ctx, async (tx) => {
        const { a, c } = await loadActionRow(tx, ctx, id);
        const ui = a.bridgeType === "ui_automation";
        if (ui && (input.requiresApproval === false || input.capturePayloads === false)) throw new AppError("VALIDATION_FAILED", "UI-automation actions always require approval and full payload capture.");
        if (ui && input.risk && RISK_ORDER[input.risk] < RISK_ORDER.high) throw new AppError("VALIDATION_FAILED", "UI-automation actions are at least high risk.");
        const patch = { ...input, ...(input.requiredPermissions ? { requiredPermissions: checkPermissions(input.requiredPermissions) } : {}), updatedAt: new Date() };
        const [u] = await tx.update(integrationActions).set(patch).where(eq(integrationActions.id, a.id)).returning();
        await record(ctx, "integration.action_updated", "integration_action", a.id, { before: actionView(a, c), after: actionView(u!, c) });
        return actionView(u!, c);
      });
    },

    // ── Transformations ───────────────────────────────────────────────────
    async listTransformations(ctx: TenantContext) {
      await authorizer.require(ctx, "integration.read");
      return tenant(ctx, async (tx) => (await tx.select().from(integrationTransformations).where(eq(integrationTransformations.organizationId, org(ctx))).orderBy(integrationTransformations.name)).map((t) => ({ id: t.id, name: t.name, description: t.description, mappings: t.mappings, updatedAt: t.updatedAt.toISOString() })));
    },

    async saveTransformation(ctx: TenantContext, raw: unknown, id?: string) {
      await authorizer.require(ctx, "integration.create");
      const input = parse(transformationSchema, raw);
      return tenant(ctx, async (tx) => {
        if (id) {
          uuidOr404(id, "Transformation");
          const [u] = await tx.update(integrationTransformations).set({ ...input, updatedAt: new Date() }).where(and(eq(integrationTransformations.organizationId, org(ctx)), eq(integrationTransformations.id, id))).returning();
          if (!u) throw notFound("Transformation", id);
          await record(ctx, "integration.transformation_updated", "integration_transformation", id, { after: input });
          return { id: u.id, name: u.name, description: u.description, mappings: u.mappings, updatedAt: u.updatedAt.toISOString() };
        }
        const [dup] = await tx.select({ id: integrationTransformations.id }).from(integrationTransformations).where(and(eq(integrationTransformations.organizationId, org(ctx)), eq(integrationTransformations.name, input.name))).limit(1);
        if (dup) throw conflict("A transformation with that name already exists.");
        const [t] = await tx.insert(integrationTransformations).values({ ...input, organizationId: org(ctx), createdBy: userId(ctx) }).returning();
        await record(ctx, "integration.transformation_created", "integration_transformation", t!.id, { after: input });
        return { id: t!.id, name: t!.name, description: t!.description, mappings: t!.mappings, updatedAt: t!.updatedAt.toISOString() };
      });
    },

    /** Dry-run mappings against sample data (no persistence). */
    async previewMappings(ctx: TenantContext, raw: unknown) {
      await authorizer.require(ctx, "integration.read");
      const input = parse(z.object({ mappings: mappingsSchema, sample: z.record(z.unknown()).default({}) }), raw);
      return applyMappings(input.mappings, input.sample);
    },

    // ── Workflows ─────────────────────────────────────────────────────────
    async listWorkflows(ctx: TenantContext) {
      await authorizer.require(ctx, "integration.read");
      return tenant(ctx, async (tx) => {
        const rows = await tx.select().from(integrationWorkflows).where(and(eq(integrationWorkflows.organizationId, org(ctx)), sql`${integrationWorkflows.status} <> 'archived'`)).orderBy(desc(integrationWorkflows.updatedAt));
        const stats = rows.length
          ? await tx
              .select({ workflowId: integrationExecutions.workflowId, status: integrationExecutions.status, n: sql<number>`count(*)::int`, last: sql<Date>`max(${integrationExecutions.createdAt})` })
              .from(integrationExecutions)
              .where(and(eq(integrationExecutions.organizationId, org(ctx)), inArray(integrationExecutions.workflowId, rows.map((r) => r.id)), gte(integrationExecutions.createdAt, new Date(Date.now() - 30 * 86400_000))))
              .groupBy(integrationExecutions.workflowId, integrationExecutions.status)
          : [];
        return rows.map((w) => {
          const s = stats.filter((x) => x.workflowId === w.id);
          const total = s.reduce((n, x) => n + x.n, 0);
          const ok = s.filter((x) => x.status === "succeeded").reduce((n, x) => n + x.n, 0);
          const last = s.map((x) => new Date(x.last).getTime()).sort().pop();
          return { ...workflowView(w), executions30d: total, successRate30d: total ? Math.round((ok / total) * 1000) / 10 : null, lastRunAt: last ? new Date(last).toISOString() : null };
        });
      });
    },

    async getWorkflow(ctx: TenantContext, id: string): Promise<WorkflowDetail> {
      await authorizer.require(ctx, "integration.read");
      return tenant(ctx, async (tx) => {
        const w = await loadWorkflow(tx, ctx, id);
        const g = await graphOf(tx, ctx, id);
        const versions = await tx.select({ version: integrationWorkflowVersions.version, changeNote: integrationWorkflowVersions.changeNote, createdAt: integrationWorkflowVersions.createdAt }).from(integrationWorkflowVersions).where(eq(integrationWorkflowVersions.workflowId, id)).orderBy(desc(integrationWorkflowVersions.version)).limit(50);
        const recent = (await authorizer.can(ctx, "integration.history.read"))
          ? await tx.select().from(integrationExecutions).where(and(eq(integrationExecutions.organizationId, org(ctx)), eq(integrationExecutions.workflowId, id))).orderBy(desc(integrationExecutions.createdAt)).limit(10)
          : [];
        return {
          ...workflowView(w),
          ...g,
          issues: validateGraph(g.nodes, g.edges, await activeActionKeys(tx, ctx)),
          versions: versions.map((v) => ({ version: v.version, changeNote: v.changeNote, createdAt: v.createdAt.toISOString(), published: v.version === w.publishedVersion })),
          recentExecutions: recent.map((e) => summary(e, w.name, null)),
        };
      });
    },

    async createWorkflow(ctx: TenantContext, raw: unknown) {
      await authorizer.require(ctx, "integration.create");
      const input = parse(workflowCreateSchema, raw);
      const inputSchema = input.inputSchema === undefined || input.inputSchema === null ? null : schemaParse(input.inputSchema, "inputSchema");
      const triggerConfig = validateTrigger(input.triggerType, input.triggerConfig);
      return tenant(ctx, async (tx) => {
        const [w] = await tx
          .insert(integrationWorkflows)
          .values({ organizationId: org(ctx), name: input.name, description: input.description, triggerType: input.triggerType, triggerConfig, inputSchema: inputSchema as unknown as Record<string, unknown> | null, createdBy: userId(ctx) })
          .returning();
        // Every workflow starts with a trigger and a completion so the editor has something to connect.
        await tx.insert(integrationNodes).values([
          { organizationId: org(ctx), workflowId: w!.id, key: "start", type: "trigger", name: "Trigger", config: {}, position: { x: 40, y: 80 }, sort: 0 },
          { organizationId: org(ctx), workflowId: w!.id, key: "done", type: "completion", name: "Complete", config: { output: {} }, position: { x: 320, y: 80 }, sort: 1 },
        ]);
        await tx.insert(integrationEdges).values({ organizationId: org(ctx), workflowId: w!.id, fromKey: "start", toKey: "done", kind: "next" });
        await tx.insert(integrationWorkflowVersions).values({ organizationId: org(ctx), workflowId: w!.id, version: 1, snapshot: await snapshotOf(tx, ctx, w!), changeNote: "Created", createdBy: userId(ctx) });
        await record(ctx, "integration.workflow_created", "integration_workflow", w!.id, { after: { name: w!.name, triggerType: w!.triggerType } });
        await bus.publish(ctx, "integration.workflow.created", { workflowId: w!.id, name: w!.name });
        return workflowView(w!);
      });
    },

    async updateWorkflow(ctx: TenantContext, id: string, raw: unknown) {
      await authorizer.require(ctx, "integration.create");
      const input = parse(workflowUpdateSchema, raw);
      return tenant(ctx, async (tx) => {
        const w = await loadWorkflow(tx, ctx, id);
        const patch: Partial<typeof integrationWorkflows.$inferInsert> = { updatedAt: new Date() };
        if (input.name !== undefined) patch.name = input.name;
        if (input.description !== undefined) patch.description = input.description;
        if (input.inputSchema !== undefined) patch.inputSchema = input.inputSchema === null ? null : (schemaParse(input.inputSchema, "inputSchema") as unknown as Record<string, unknown>);
        if (input.triggerType !== undefined || input.triggerConfig !== undefined) {
          patch.triggerType = input.triggerType ?? w.triggerType;
          patch.triggerConfig = validateTrigger(patch.triggerType, input.triggerConfig ?? w.triggerConfig);
        }
        await tx.update(integrationWorkflows).set(patch).where(eq(integrationWorkflows.id, id));
        const u = await newVersion(tx, ctx, id, "Settings updated");
        await record(ctx, "integration.workflow_updated", "integration_workflow", id, { before: workflowView(w), after: workflowView(u) });
        return workflowView(u);
      });
    },

    async saveGraph(ctx: TenantContext, id: string, raw: unknown) {
      await authorizer.require(ctx, "integration.create");
      const input = parse(saveGraphSchema, raw);
      const keys = new Set<string>();
      for (const n of input.nodes) {
        if (keys.has(n.key)) throw new AppError("VALIDATION_FAILED", `Duplicate node key "${n.key}".`);
        keys.add(n.key);
      }
      for (const e of input.edges) if (!keys.has(e.from) || !keys.has(e.to)) throw new AppError("VALIDATION_FAILED", `Edge ${e.from} → ${e.to} references an unknown node.`);
      return tenant(ctx, async (tx) => {
        const w = await loadWorkflow(tx, ctx, id);
        if (w.status === "archived") throw conflict("Archived workflows cannot be edited.");
        await tx.delete(integrationEdges).where(and(eq(integrationEdges.organizationId, org(ctx)), eq(integrationEdges.workflowId, id)));
        await tx.delete(integrationNodes).where(and(eq(integrationNodes.organizationId, org(ctx)), eq(integrationNodes.workflowId, id)));
        if (input.nodes.length) await tx.insert(integrationNodes).values(input.nodes.map((n, i) => ({ organizationId: org(ctx), workflowId: id, key: n.key, type: n.type, name: n.name, config: n.config, position: n.position, sort: i })));
        if (input.edges.length) await tx.insert(integrationEdges).values(input.edges.map((e) => ({ organizationId: org(ctx), workflowId: id, fromKey: e.from, toKey: e.to, kind: e.kind, label: e.label ?? null })));
        const u = await newVersion(tx, ctx, id, input.changeNote ?? "Graph updated");
        const issues = validateGraph(input.nodes as NodeDef[], input.edges as EdgeDef[], await activeActionKeys(tx, ctx));
        await record(ctx, "integration.workflow_graph_saved", "integration_workflow", id, { metadata: { version: u.currentVersion, nodes: input.nodes.length, edges: input.edges.length, issues: issues.length } });
        return { version: u.currentVersion, issues };
      });
    },

    async publishWorkflow(ctx: TenantContext, id: string) {
      await authorizer.require(ctx, "integration.manage");
      return tenant(ctx, async (tx) => {
        const w = await loadWorkflow(tx, ctx, id);
        if (w.status === "archived") throw conflict("Archived workflows cannot be published.");
        const g = await graphOf(tx, ctx, id);
        const issues = validateGraph(g.nodes, g.edges, await activeActionKeys(tx, ctx));
        if (issues.length) throw new AppError("VALIDATION_FAILED", `Fix ${issues.length} issue(s) before publishing.`, { issues: issues.map((i) => ({ path: i.node ?? "workflow", message: i.message })) });
        const [u] = await tx.update(integrationWorkflows).set({ status: "active", publishedVersion: w.currentVersion, runAsUserId: userId(ctx), updatedAt: new Date() }).where(eq(integrationWorkflows.id, id)).returning();
        await record(ctx, "integration.workflow_published", "integration_workflow", id, { after: { version: w.currentVersion, triggerType: w.triggerType, runAs: userId(ctx) } });
        return workflowView(u!);
      });
    },

    async setWorkflowStatus(ctx: TenantContext, id: string, status: "paused" | "archived" | "active") {
      await authorizer.require(ctx, "integration.manage");
      return tenant(ctx, async (tx) => {
        const w = await loadWorkflow(tx, ctx, id);
        if (status === "active" && !w.publishedVersion) throw conflict("Publish the workflow before activating it.");
        const [u] = await tx.update(integrationWorkflows).set({ status, updatedAt: new Date() }).where(eq(integrationWorkflows.id, id)).returning();
        await record(ctx, `integration.workflow_${status}`, "integration_workflow", id, { before: { status: w.status }, after: { status } });
        return workflowView(u!);
      });
    },

    async getVersion(ctx: TenantContext, id: string, version: number) {
      await authorizer.require(ctx, "integration.read");
      return tenant(ctx, async (tx) => {
        await loadWorkflow(tx, ctx, id);
        const [v] = await tx.select().from(integrationWorkflowVersions).where(and(eq(integrationWorkflowVersions.workflowId, id), eq(integrationWorkflowVersions.version, version))).limit(1);
        if (!v) throw notFound("Workflow version", String(version));
        return { version: v.version, snapshot: v.snapshot, changeNote: v.changeNote, createdAt: v.createdAt.toISOString() };
      });
    },

    /** Create the sample quote workflow and its sandbox actions (non-production only: needs the sandbox connector type). */
    async createSample(ctx: TenantContext) {
      await authorizer.require(ctx, "integration.manage");
      await authorizer.require(ctx, "integration.create");
      if (!connectorService.catalog().some((d) => d.type === "sandbox")) throw new AppError("NOT_CONFIGURED", "Sample workflows use the simulated sandbox connector, which is not available in production.");
      let [sandbox] = await tenant(ctx, (tx) => tx.select().from(connectors).where(and(eq(connectors.organizationId, org(ctx)), eq(connectors.type, "sandbox"))).limit(1));
      if (!sandbox) {
        const created = await connectorService.create(ctx, { type: "sandbox", name: "Sample sandbox (simulated)", authType: "none", config: {} });
        [sandbox] = await tenant(ctx, (tx) => tx.select().from(connectors).where(eq(connectors.id, created.id)).limit(1));
      }
      for (const s of SAMPLE_ACTIONS) {
        const [exists] = await tenant(ctx, (tx) => tx.select({ id: integrationActions.id }).from(integrationActions).where(and(eq(integrationActions.organizationId, org(ctx)), eq(integrationActions.key, s.key))).limit(1));
        if (!exists) await installTemplateInternal(ctx, templateByKey(s.templateKey)!, { connectorId: sandbox!.id, key: s.key, name: s.name, aiExposed: s.key === "sample.lookup_customer" });
      }
      const w = await this.createWorkflow(ctx, { name: "Customer quote request (sample)", description: "Customer request → AI interpretation → CRM lookup → inventory → pricing → manager approval → quote → CRM update → response. Runs against the SIMULATED sandbox connector.", inputSchema: SAMPLE_INPUT_SCHEMA });
      await tenant(ctx, (tx) => tx.update(integrationWorkflows).set({ isSample: true }).where(eq(integrationWorkflows.id, w.id)));
      await this.saveGraph(ctx, w.id, { nodes: SAMPLE_NODES, edges: SAMPLE_EDGES, changeNote: "Sample workflow" });
      return this.getWorkflow(ctx, w.id);
    },

    // ── Executions ────────────────────────────────────────────────────────
    async startExecution(ctx: TenantContext, workflowId: string, raw: unknown, trigger: "manual" | "api" = "manual") {
      await authorizer.require(ctx, "integration.execute");
      const input = parse(startSchema, raw);
      const { w, version } = await tenant(ctx, async (tx) => {
        const w = await loadWorkflow(tx, ctx, workflowId);
        if (input.mode === "live" && (w.status !== "active" || !w.publishedVersion)) throw conflict("Only active, published workflows run live. Use test mode to try a draft.");
        if (input.mode === "live" && trigger === "api" && w.triggerType === "manual") throw conflict("This workflow accepts manual runs only.");
        return { w, version: input.mode === "live" ? w.publishedVersion! : w.currentVersion };
      });
      let runInput = input.input;
      if (w.inputSchema) {
        const v = validate(parseJsonSchema(w.inputSchema), input.input);
        if (v.issues.length) throw new AppError("VALIDATION_FAILED", "Workflow input is invalid.", { issues: v.issues });
        runInput = v.value as Record<string, unknown>;
      }
      const { row, duplicate } = await createExecution(ctx, { workflowId, workflowVersion: version, mode: input.mode, trigger, input: runInput, idempotencyKey: input.idempotencyKey });
      if (duplicate) return executionDetail(ctx, row.id);
      return dispatch(ctx, row, input.wait || input.mode === "test");
    },

    /** Event triggers: run as the user who published the workflow (permissions re-checked at run time). */
    async onEvent(event: { id: string; type: string; organizationId: string | null; payload: unknown; occurredAt: string; correlationId?: string | null }) {
      if (!event.organizationId || event.type.startsWith("integration.")) return;
      const orgId = event.organizationId;
      const rows = await db.withTenant({ organizationId: orgId }, (tx) =>
        tx
          .select({ w: integrationWorkflows, email: users.email })
          .from(integrationWorkflows)
          .innerJoin(users, eq(users.id, integrationWorkflows.runAsUserId))
          .where(and(eq(integrationWorkflows.organizationId, orgId), eq(integrationWorkflows.status, "active"), eq(integrationWorkflows.triggerType, "event"), sql`${integrationWorkflows.triggerConfig}->>'eventType' = ${event.type}`)),
      );
      for (const { w, email } of rows) {
        const ctx: TenantContext = { organizationId: orgId, actor: { type: "user", id: w.runAsUserId!, label: email }, correlationId: event.correlationId ?? event.id, cache: new Map() };
        if (!(await authorizer.can(ctx, "integration.execute"))) continue;
        const { row, duplicate } = await createExecution(ctx, { workflowId: w.id, workflowVersion: w.publishedVersion, mode: "live", trigger: "event", input: { event: { id: event.id, type: event.type, payload: event.payload, occurredAt: event.occurredAt } }, idempotencyKey: `event:${event.id}` });
        if (!duplicate) await jobs.enqueue(RUN_JOB, { executionId: row.id }, { organizationId: orgId, idempotencyKey: `${row.id}:start` });
      }
    },

    async listExecutions(ctx: TenantContext, q: { workflowId?: string; status?: string; mode?: string; limit?: number; cursor?: string } = {}): Promise<Page<ExecutionSummary>> {
      await authorizer.require(ctx, "integration.history.read");
      const limit = Math.min(200, Math.max(1, q.limit ?? 50));
      const cur = decodeCursor(q.cursor);
      return tenant(ctx, async (tx) => {
        const rows = await tx
          .select({ e: integrationExecutions, wfName: integrationWorkflows.name, actionKey: integrationActions.key })
          .from(integrationExecutions)
          .leftJoin(integrationWorkflows, eq(integrationWorkflows.id, integrationExecutions.workflowId))
          .leftJoin(integrationActions, eq(integrationActions.id, integrationExecutions.actionId))
          .where(
            and(
              eq(integrationExecutions.organizationId, org(ctx)),
              q.workflowId && isUuid(q.workflowId) ? eq(integrationExecutions.workflowId, q.workflowId) : undefined,
              q.status ? eq(integrationExecutions.status, q.status as ExecutionRow["status"]) : undefined,
              q.mode ? eq(integrationExecutions.mode, q.mode as ExecutionRow["mode"]) : undefined,
              cur ? or(lt(integrationExecutions.createdAt, new Date(cur.t)), and(eq(integrationExecutions.createdAt, new Date(cur.t)), lt(integrationExecutions.id, cur.id))) : undefined,
            ),
          )
          .orderBy(desc(integrationExecutions.createdAt), desc(integrationExecutions.id))
          .limit(limit + 1);
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return { data: page.map((r) => summary(r.e, r.wfName, r.actionKey)), nextCursor: rows.length > limit && last ? encodeCursor({ t: last.e.createdAt.toISOString(), id: last.e.id }) : undefined } as Page<ExecutionSummary>;
      });
    },

    async getExecution(ctx: TenantContext, id: string) {
      await authorizer.require(ctx, "integration.history.read");
      return executionDetail(ctx, id);
    },

    async cancelExecution(ctx: TenantContext, id: string) {
      await authorizer.require(ctx, "integration.execute");
      uuidOr404(id, "Execution");
      await tenant(ctx, async (tx) => {
        const [e] = await tx.select().from(integrationExecutions).where(and(eq(integrationExecutions.organizationId, org(ctx)), eq(integrationExecutions.id, id))).limit(1);
        if (!e) throw notFound("Execution", id);
        if ((TERMINAL_STATUSES as string[]).includes(e.status)) throw conflict(`The execution already ${e.status.replace("_", " ")}.`);
        if (e.actor.id !== ctx.actor.id && !(await authorizer.can(ctx, "integration.manage"))) throw forbidden("Only the initiator or an integration manager can cancel this execution.");
        await tx.update(integrationExecutions).set({ status: "cancelled", finishedAt: new Date(), currentNode: null }).where(eq(integrationExecutions.id, id));
        await tx.update(integrationApprovalBindings).set({ status: "cancelled", decidedAt: new Date() }).where(and(eq(integrationApprovalBindings.executionId, id), eq(integrationApprovalBindings.status, "pending")));
        await record(ctx, "integration.execution_cancelled", "integration_execution", id, { before: { status: e.status } });
      });
      return executionDetail(ctx, id);
    },

    /** Resume a failed execution from the failing step (idempotency keeps completed writes from repeating). */
    async retryExecution(ctx: TenantContext, id: string, opts: { wait?: boolean } = {}) {
      await authorizer.require(ctx, "integration.manage");
      uuidOr404(id, "Execution");
      const row = await tenant(ctx, async (tx) => {
        const [e] = await tx.select().from(integrationExecutions).where(and(eq(integrationExecutions.organizationId, org(ctx)), eq(integrationExecutions.id, id))).limit(1);
        if (!e) throw notFound("Execution", id);
        if (e.status !== "failed" && e.status !== "partially_failed") throw conflict("Only failed executions can be retried.");
        const st: ExecutionState = { ...e.state, resumeNode: e.state.lastError?.nodeKey ?? e.state.resumeNode ?? null, attempts: {}, lastError: null, vars: { ...(e.state.vars ?? {}), handledErrors: 0 } };
        const [u] = await tx.update(integrationExecutions).set({ status: "queued", state: st, finishedAt: null, errorClass: null, errorMessage: null }).where(eq(integrationExecutions.id, id)).returning();
        await tx.update(integrationErrors).set({ status: "retrying" }).where(and(eq(integrationErrors.executionId, id), inArray(integrationErrors.status, ["open", "dead_letter"])));
        await record(ctx, "integration.execution_retried", "integration_execution", id, { metadata: { fromNode: st.resumeNode } });
        return u!;
      });
      return dispatch(ctx, row, !!opts.wait);
    },

    // ── Approvals ─────────────────────────────────────────────────────────
    async listApprovals(ctx: TenantContext, q: { status?: string } = {}) {
      await authorizer.require(ctx, "integration.read");
      return tenant(ctx, async (tx) => {
        const rows = await tx
          .select({ a: integrationApprovalBindings, wfName: integrationWorkflows.name })
          .from(integrationApprovalBindings)
          .innerJoin(integrationExecutions, eq(integrationExecutions.id, integrationApprovalBindings.executionId))
          .leftJoin(integrationWorkflows, eq(integrationWorkflows.id, integrationExecutions.workflowId))
          .where(and(eq(integrationApprovalBindings.organizationId, org(ctx)), q.status ? eq(integrationApprovalBindings.status, q.status as ApprovalRow["status"]) : undefined))
          .orderBy(desc(integrationApprovalBindings.createdAt))
          .limit(500);
        return rows.map((r) => approvalView(r.a, r.wfName));
      });
    },

    async decideApproval(ctx: TenantContext, id: string, raw: unknown, opts: { wait?: boolean } = {}) {
      await authorizer.require(ctx, "integration.approve");
      const input = parse(decisionSchema, raw);
      uuidOr404(id, "Approval");
      const ex = await tenant(ctx, async (tx) => {
        const [a] = await tx.select().from(integrationApprovalBindings).where(and(eq(integrationApprovalBindings.organizationId, org(ctx)), eq(integrationApprovalBindings.id, id))).limit(1);
        if (!a) throw notFound("Approval", id);
        if (a.status !== "pending") throw conflict(`This approval is already ${a.status}.`);
        if (a.expiresAt.getTime() <= Date.now()) throw conflict("This approval has expired.");
        // Separation of duties: whoever started the execution cannot approve it.
        if (a.requestedBy.id === ctx.actor.id) {
          await audit.recordDetached(ctx, { module: MODULE_ID, action: "integration.approval_decided", resourceType: "integration_approval", resourceId: id, outcome: "denied", metadata: { reason: "separation_of_duties" } });
          throw forbidden("Separation of duties: the initiator of an execution cannot approve its actions.");
        }
        const status = input.decision === "approve" ? "approved" : "rejected";
        await tx.update(integrationApprovalBindings).set({ status, decidedBy: userId(ctx), decidedAt: new Date(), decisionNote: input.note ?? null }).where(eq(integrationApprovalBindings.id, id));
        const [e] = await tx.update(integrationExecutions).set({ status: "queued" }).where(and(eq(integrationExecutions.id, a.executionId), eq(integrationExecutions.status, "waiting_approval"))).returning();
        await record(ctx, "integration.approval_decided", "integration_approval", id, { after: { status, note: input.note }, metadata: { executionId: a.executionId, nodeKey: a.nodeKey, risk: a.risk } });
        return e ?? null;
      });
      if (ex) await dispatch(ctx, ex, !!opts.wait);
      const [row] = await tenant(ctx, (tx) => tx.select().from(integrationApprovalBindings).where(eq(integrationApprovalBindings.id, id)).limit(1));
      return approvalView(row!);
    },

    // ── AI tool gateway ───────────────────────────────────────────────────
    async listTools(ctx: TenantContext) {
      await authorizer.require(ctx, "integration.execute");
      const actions = await tenant(ctx, (tx) => tx.select().from(integrationActions).where(and(eq(integrationActions.organizationId, org(ctx)), eq(integrationActions.status, "active"), eq(integrationActions.aiExposed, true))).orderBy(integrationActions.key));
      const out = [];
      for (const a of actions) {
        let allowed = true;
        for (const p of a.requiredPermissions) if (!(await authorizer.can(ctx, p))) allowed = false;
        if (allowed) out.push(toolDefinition({ ...a, inputSchema: a.inputSchema as unknown as JsonSchema }));
      }
      return out;
    },

    /**
     * The ONLY way AI callers reach enterprise systems. Validates the caller,
     * organization (from the authenticated context, never the body), action
     * exposure, parameters, permissions and policy, then runs the action
     * through the same engine as workflows (approval, idempotency, retries,
     * breaker, audit).
     */
    async invokeTool(ctx: TenantContext, toolName: string, raw: unknown) {
      await authorizer.require(ctx, "integration.execute");
      await authorizer.require(ctx, "integration.connector.use");
      const input = parse(invokeToolSchema, raw);
      const [action] = await tenant(ctx, (tx) => tx.select().from(integrationActions).where(and(eq(integrationActions.organizationId, org(ctx)), eq(integrationActions.key, toolName))).limit(1));
      if (!action || action.status !== "active" || !action.aiExposed) throw notFound("Tool", toolName);
      if (action.idempotency === "key_required" && !input.idempotencyKey) throw new AppError("VALIDATION_FAILED", "This tool requires an idempotencyKey.");
      const v = validate(parseJsonSchema(action.inputSchema), input.input);
      if (v.issues.length) throw new AppError("VALIDATION_FAILED", `Invalid parameters for tool "${toolName}".`, { issues: v.issues });
      // Agent identity: a verified agent actor, or a claim recorded as unverified alongside the authenticated caller.
      const agent = ctx.actor.type === "agent" ? { id: ctx.actor.id, name: ctx.actor.label, verified: true } : input.agent ? { ...input.agent, verified: false } : null;
      const { row, duplicate } = await createExecution(ctx, { actionId: action.id, mode: input.mode, trigger: "gateway", input: v.value as Record<string, unknown>, idempotencyKey: input.idempotencyKey, agent });
      const detail = duplicate ? await executionDetail(ctx, row.id) : await dispatch(ctx, row, true);
      return {
        executionId: detail.id,
        status: detail.status,
        output: detail.status === "succeeded" ? detail.output : null,
        approvalId: detail.approvals.find((a) => a.status === "pending")?.id ?? null,
        error: detail.errorClass ? { class: detail.errorClass, message: detail.errorMessage } : null,
        duplicate,
      };
    },

    // ── Errors / dead letters / health ────────────────────────────────────
    async listErrors(ctx: TenantContext, q: { status?: string } = {}) {
      await authorizer.require(ctx, "integration.history.read");
      return tenant(ctx, async (tx) =>
        (await tx.select().from(integrationErrors).where(and(eq(integrationErrors.organizationId, org(ctx)), q.status ? eq(integrationErrors.status, q.status as "open") : undefined)).orderBy(desc(integrationErrors.createdAt)).limit(500)).map(errorView),
      );
    },

    async resolveError(ctx: TenantContext, id: string) {
      await authorizer.require(ctx, "integration.manage");
      uuidOr404(id, "Error");
      return tenant(ctx, async (tx) => {
        const [u] = await tx.update(integrationErrors).set({ status: "resolved", resolvedBy: userId(ctx), resolvedAt: new Date() }).where(and(eq(integrationErrors.organizationId, org(ctx)), eq(integrationErrors.id, id))).returning();
        if (!u) throw notFound("Error", id);
        await record(ctx, "integration.error_resolved", "integration_error", id);
        return errorView(u);
      });
    },

    async overview(ctx: TenantContext): Promise<OverviewView> {
      await authorizer.require(ctx, "integration.read");
      const canHistory = await authorizer.can(ctx, "integration.history.read");
      return tenant(ctx, async (tx) => {
        const since = new Date(Date.now() - 7 * 86400_000);
        const byStatus = canHistory
          ? await tx.select({ status: integrationExecutions.status, n: sql<number>`count(*)::int`, avg: sql<number | null>`avg(${integrationExecutions.durationMs})::int` }).from(integrationExecutions).where(and(eq(integrationExecutions.organizationId, org(ctx)), gte(integrationExecutions.createdAt, since), eq(integrationExecutions.mode, "live"))).groupBy(integrationExecutions.status)
          : [];
        const executions7d = Object.fromEntries(byStatus.map((r) => [r.status, r.n]));
        const finished = byStatus.filter((r) => (TERMINAL_STATUSES as string[]).includes(r.status) && r.status !== "cancelled");
        const total = finished.reduce((n, r) => n + r.n, 0);
        const ok = executions7d.succeeded ?? 0;
        const avgNum = finished.reduce((n, r) => n + (r.avg ?? 0) * r.n, 0);
        const [pending] = await tx.select({ n: sql<number>`count(*)::int` }).from(integrationApprovalBindings).where(and(eq(integrationApprovalBindings.organizationId, org(ctx)), eq(integrationApprovalBindings.status, "pending")));
        const errs = await tx.select({ status: integrationErrors.status, n: sql<number>`count(*)::int` }).from(integrationErrors).where(eq(integrationErrors.organizationId, org(ctx))).groupBy(integrationErrors.status);
        const [wfs] = await tx.select({ n: sql<number>`count(*)::int` }).from(integrationWorkflows).where(and(eq(integrationWorkflows.organizationId, org(ctx)), eq(integrationWorkflows.status, "active")));
        const acts = await tx.select({ connectorId: integrationActions.connectorId, name: connectors.name }).from(integrationActions).innerJoin(connectors, eq(connectors.id, integrationActions.connectorId)).where(eq(integrationActions.organizationId, org(ctx)));
        const connectorIds = [...new Map(acts.map((a) => [a.connectorId, a.name])).entries()];
        const failures = connectorIds.length
          ? await tx
              .select({ connectorId: integrationErrors.connectorId, at: integrationErrors.createdAt })
              .from(integrationErrors)
              .where(and(eq(integrationErrors.organizationId, org(ctx)), inArray(integrationErrors.errorClass, ["transient", "timeout", "rate_limited"]), gte(integrationErrors.createdAt, new Date(Date.now() - 300_000))))
          : [];
        return {
          executions7d,
          successRate7d: total ? Math.round((ok / total) * 1000) / 10 : null,
          avgDurationMs7d: total ? Math.round(avgNum / total) : null,
          pendingApprovals: pending?.n ?? 0,
          deadLetters: errs.find((e) => e.status === "dead_letter")?.n ?? 0,
          openErrors: errs.find((e) => e.status === "open")?.n ?? 0,
          activeWorkflows: wfs?.n ?? 0,
          actions: acts.length,
          breakers: connectorIds.map(([connectorId, connectorName]) => ({ connectorId, connectorName, ...breakerState(failures.filter((f) => f.connectorId === connectorId).map((f) => f.at), new Date()) })),
        };
      });
    },

    /** Schema registry for developers: node types, edge kinds, transform functions, error classes, templates. */
    schemas() {
      return { nodeTypes: NODE_TYPES, edgeKinds: EDGE_KINDS, bridgeTypes: BRIDGE_TYPES, transforms: Object.keys(TRANSFORMS), fieldTypes: FIELD_TYPES, errorClasses: ERROR_CLASSES, templates: ACTION_TEMPLATES.map((t) => ({ key: t.key, connectorType: t.connectorType, name: t.name, capability: t.capability, operation: t.operation, risk: t.risk, inputSchema: t.inputSchema })) };
    },
  };

  async function installTemplateInternal(ctx: TenantContext, t: ActionTemplate, input: Partial<z.output<typeof installTemplateSchema>> & { connectorId: string }) {
    const c = await connectorRow(ctx, input.connectorId);
    if (c.type !== t.connectorType) throw new AppError("VALIDATION_FAILED", `Template "${t.key}" needs a ${t.connectorType} connector (got ${c.type}).`);
    const caps = await connectorService.get(ctx, c.id).catch(() => null);
    const cap = caps?.capabilities.find((x) => x.key === t.capability);
    if (caps && (!cap || !cap.enabled)) throw new AppError("VALIDATION_FAILED", `Capability "${t.capability}" is not enabled on connector "${c.name}". Enable it under Administration → Connectors.`);
    const key = input.key ?? `${t.key.split(".")[1]!}.${c.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30) || "default"}`.replace(/^([^a-z])/, "a$1");
    return tenant(ctx, async (tx) => {
      const [dup] = await tx.select({ id: integrationActions.id }).from(integrationActions).where(and(eq(integrationActions.organizationId, org(ctx)), eq(integrationActions.key, key))).limit(1);
      if (dup) throw conflict(`An action with key "${key}" already exists.`);
      const risk = input.risk ? maxRisk(input.risk, t.risk) : t.risk; // templates can be made stricter, never laxer
      const [a] = await tx
        .insert(integrationActions)
        .values({
          organizationId: org(ctx), key, name: input.name ?? t.name, description: t.description, connectorId: c.id, capability: t.capability, operation: t.operation, kind: "catalog", templateKey: t.key,
          bridgeType: "native", inputSchema: t.inputSchema as unknown as Record<string, unknown>, outputSchema: (t.outputSchema as unknown as Record<string, unknown>) ?? null, requestTemplate: t.requestTemplate,
          requiredPermissions: ["integration.execute"], risk, requiresApproval: t.requiresApproval || !!input.requiresApproval, idempotency: t.idempotency, timeoutMs: input.timeoutMs ?? 30_000,
          rateLimitPerMinute: input.rateLimitPerMinute ?? null, retry: input.retry ?? { maxAttempts: 3, backoffSeconds: 10 }, compensation: input.compensation ?? null, aiExposed: input.aiExposed ?? false, createdBy: userId(ctx),
        })
        .returning();
      await record(ctx, "integration.action_created", "integration_action", a!.id, { after: { key, templateKey: t.key, connectorId: c.id, risk, requiresApproval: a!.requiresApproval } });
      return actionView(a!, c);
    });
  }
}

