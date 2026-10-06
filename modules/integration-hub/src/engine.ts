import { type AIService } from "@eaop/ai";
import { type AuditService } from "@eaop/audit";
import { type ConnectorService } from "@eaop/connectors";
import { and, connectors, desc, eq, gte, inArray, sql, type Database, type Tx } from "@eaop/db";
import { type EventBus } from "@eaop/events";
import { type JobQueue } from "@eaop/jobs";
import { type NotificationService } from "@eaop/notifications";
import { type Logger } from "@eaop/observability";
import { type PolicyEngine, type PolicyService } from "@eaop/policies";
import { type Authorizer } from "@eaop/rbac";
import { type RateLimiter } from "@eaop/security";
import { type TenantContext } from "@eaop/shared-types";
import { nextNode, NODE_CONFIG_SCHEMAS } from "./graph";
import { applyMappings, mappingsSchema, render, resolvePath, type Mapping } from "./mapping";
import {
  BREAKER_CLASSES, breakerState, classifyError, decideRetry, IntegrationError, summarizePayload, withTimeout, type ClassifiedError,
} from "./reliability";
import {
  integrationActions, integrationApprovalBindings, integrationErrors, integrationExecutions, integrationExecutionSteps, integrationTransformations,
  integrationWorkflowVersions, TERMINAL_STATUSES, type EdgeDef, type ExecutionState, type NodeDef, type StoredActor, type WorkflowSnapshot,
} from "./schema";
import { parseJsonSchema, validate, type JsonSchema } from "./validation";

export const MODULE_ID = "integration_hub" as const;
export const RUN_JOB = "integration.execution.run";
export const EXPIRE_JOB = "integration.approval.expire";
const MAX_STEPS = 500;
const MAX_STATE_BYTES = 1_000_000;
const BASE = "/m/integration-hub";

export interface EngineDeps {
  db: Database;
  authorizer: Authorizer;
  audit: AuditService;
  bus: EventBus;
  notifications: NotificationService;
  ai: AIService;
  connectors: ConnectorService;
  jobs: JobQueue;
  policies: PolicyService;
  policyEngine: PolicyEngine;
  rateLimiter: RateLimiter;
  logger: Logger;
}

type ExecutionRow = typeof integrationExecutions.$inferSelect;
type ActionRow = typeof integrationActions.$inferSelect;
type ActionWithConnector = ActionRow & { connectorType: string; connectorName: string };

/** Rebuild the initiating actor's context; permissions are re-checked on every step. */
export function ctxFor(ex: Pick<ExecutionRow, "organizationId" | "actor" | "correlationId" | "id">): TenantContext {
  const a = ex.actor;
  return { organizationId: ex.organizationId, actor: { type: a.type, id: a.id, label: a.label, ...(a.scopes ? { scopes: a.scopes } : {}) }, correlationId: ex.correlationId ?? ex.id, cache: new Map() };
}

export function storedActor(ctx: TenantContext): StoredActor {
  return { type: ctx.actor.type, id: ctx.actor.id, label: ctx.actor.label, ...(ctx.actor.scopes ? { scopes: ctx.actor.scopes } : {}) };
}

/** Single-action executions (AI tool gateway) run this synthetic graph. */
export function gatewaySnapshot(actionKey: string): WorkflowSnapshot {
  return {
    name: `Gateway call: ${actionKey}`, description: "", triggerType: "api", triggerConfig: {}, inputSchema: null,
    nodes: [
      { key: "start", type: "trigger", name: "Tool call", config: {}, position: { x: 0, y: 0 } },
      { key: "action", type: "connector_action", name: actionKey, config: { actionKey, input: "{{input}}" }, position: { x: 200, y: 0 } },
      { key: "done", type: "completion", name: "Result", config: { output: "{{steps.action}}" }, position: { x: 400, y: 0 } },
    ],
    edges: [{ from: "start", to: "action", kind: "next" }, { from: "action", to: "done", kind: "next" }],
  };
}

/** Example value satisfying a schema — used ONLY for test-mode runs against the simulated AI provider. */
export function sampleFromSchema(s: JsonSchema): unknown {
  if (s.default !== undefined) return s.default;
  switch (s.type) {
    case "object":
      return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, sampleFromSchema(v)]));
    case "string":
      return s.enum?.[0] ?? (s.format === "email" ? "test@example.com" : s.format === "date" ? "2026-01-01" : "sample");
    case "number":
    case "integer":
      return typeof s.enum?.[0] === "number" ? s.enum[0] : (s.minimum ?? 0);
    case "boolean":
      return false;
    case "array":
      return [];
  }
}

type StepOutcome =
  | { kind: "next"; edge: "next" | "true" | "false" | "case" | "rejected"; caseValue?: string; output?: unknown }
  | { kind: "wait"; status: "waiting_approval" | "waiting_delay"; runAt?: Date }
  | { kind: "error"; error: ClassifiedError }
  | { kind: "complete"; output: unknown };

export function createEngine(deps: EngineDeps) {
  const { db, authorizer, audit, bus, notifications, ai, connectors: connectorService, jobs, policies, policyEngine, rateLimiter, logger } = deps;
  const tenant = <T>(orgId: string, fn: (tx: Tx) => Promise<T>) => db.withTenant({ organizationId: orgId }, fn);

  async function loadSnapshot(ex: ExecutionRow): Promise<WorkflowSnapshot> {
    if (!ex.workflowId) {
      const [a] = await tenant(ex.organizationId, (tx) => tx.select({ key: integrationActions.key }).from(integrationActions).where(eq(integrationActions.id, ex.actionId!)).limit(1));
      if (!a) throw new IntegrationError("configuration", "The action for this execution no longer exists.");
      return gatewaySnapshot(a.key);
    }
    const [v] = await tenant(ex.organizationId, (tx) =>
      tx.select().from(integrationWorkflowVersions).where(and(eq(integrationWorkflowVersions.workflowId, ex.workflowId!), eq(integrationWorkflowVersions.version, ex.workflowVersion!))).limit(1),
    );
    if (!v) throw new IntegrationError("configuration", "The workflow version for this execution no longer exists.");
    return v.snapshot;
  }

  async function loadAction(orgId: string, key: string): Promise<ActionWithConnector> {
    const [row] = await tenant(orgId, (tx) =>
      tx
        .select({ a: integrationActions, connectorType: connectors.type, connectorName: connectors.name })
        .from(integrationActions)
        .innerJoin(connectors, eq(connectors.id, integrationActions.connectorId))
        .where(and(eq(integrationActions.organizationId, orgId), eq(integrationActions.key, key)))
        .limit(1),
    );
    if (!row) throw new IntegrationError("configuration", `Action "${key}" does not exist.`);
    if (row.a.status !== "active") throw new IntegrationError("configuration", `Action "${key}" is disabled.`);
    return { ...row.a, connectorType: row.connectorType, connectorName: row.connectorName };
  }

  const scopeFor = (ex: ExecutionRow, st: ExecutionState) => ({
    input: ex.input,
    steps: st.steps ?? {},
    vars: st.vars ?? {},
    error: st.lastError ?? null,
    execution: { id: ex.id, mode: ex.mode, workflowId: ex.workflowId, trigger: ex.trigger },
  });

  async function recordStep(ex: ExecutionRow, st: ExecutionState, node: NodeDef, s: Partial<typeof integrationExecutionSteps.$inferInsert> & { status: (typeof integrationExecutionSteps.$inferInsert)["status"]; startedAt: Date }) {
    st.seq = (st.seq ?? 0) + 1;
    const finished = new Date();
    await tenant(ex.organizationId, (tx) =>
      tx.insert(integrationExecutionSteps).values({
        organizationId: ex.organizationId, executionId: ex.id, seq: st.seq!, nodeKey: node.key, nodeType: node.type, attempt: (st.attempts?.[node.key] ?? 0) + 1,
        ...s, finishedAt: finished, durationMs: finished.getTime() - s.startedAt.getTime(),
      }),
    );
  }

  async function saveState(ex: ExecutionRow, st: ExecutionState, patch: Partial<typeof integrationExecutions.$inferInsert> = {}) {
    if (JSON.stringify(st).length > MAX_STATE_BYTES) throw new IntegrationError("validation", "Execution state exceeds 1 MB — reduce the data passed between steps.");
    await tenant(ex.organizationId, (tx) => tx.update(integrationExecutions).set({ state: st, ...patch }).where(eq(integrationExecutions.id, ex.id)));
  }

  async function openApproval(ex: ExecutionRow, node: NodeDef, a: { actionId?: string | null; title: string; system?: string | null; reason: string; risk: "low" | "medium" | "high" | "critical"; businessImpact?: string | null; affectedData?: unknown; payload: unknown; policyDecision?: Record<string, unknown> | null; expiresHours: number }) {
    const expiresAt = new Date(Date.now() + a.expiresHours * 3600_000);
    const created = await tenant(ex.organizationId, async (tx) => {
      const [row] = await tx
        .insert(integrationApprovalBindings)
        .values({
          organizationId: ex.organizationId, executionId: ex.id, nodeKey: node.key, actionId: a.actionId ?? null, title: a.title, system: a.system ?? null, reason: a.reason, risk: a.risk,
          businessImpact: a.businessImpact ?? null, affectedData: a.affectedData ?? null, proposedPayload: a.payload, policyDecision: a.policyDecision ?? null, requestedBy: ex.actor, expiresAt,
        })
        .onConflictDoNothing()
        .returning();
      return row;
    });
    if (!created) return;
    const ctx = ctxFor(ex);
    await audit.record(ctx, { module: MODULE_ID, action: "integration.approval_requested", resourceType: "integration_approval", resourceId: created.id, metadata: { executionId: ex.id, nodeKey: node.key, risk: a.risk } });
    await bus.publish(ctx, "integration.approval.required", { approvalId: created.id, executionId: ex.id, nodeKey: node.key, risk: a.risk, title: a.title });
    await notifications.notify(ctx, { type: "integration.approval_required", title: `Approval needed: ${a.title}`, body: a.reason, actionUrl: `${BASE}/approvals?focus=${created.id}`, recipients: { permission: "integration.approve" }, priority: a.risk === "critical" || a.risk === "high" ? "high" : "normal" });
    await jobs.enqueue(EXPIRE_JOB, { approvalId: created.id }, { organizationId: ex.organizationId, runAt: expiresAt, idempotencyKey: `expire:${created.id}` });
  }

  async function approvalFor(ex: ExecutionRow, nodeKey: string) {
    const [row] = await tenant(ex.organizationId, (tx) =>
      tx.select().from(integrationApprovalBindings).where(and(eq(integrationApprovalBindings.executionId, ex.id), eq(integrationApprovalBindings.nodeKey, nodeKey))).limit(1),
    );
    return row ?? null;
  }

  async function breakerFor(orgId: string, connectorId: string) {
    const since = new Date(Date.now() - 300_000);
    const rows = await tenant(orgId, (tx) =>
      tx
        .select({ at: integrationErrors.createdAt })
        .from(integrationErrors)
        .where(and(eq(integrationErrors.organizationId, orgId), eq(integrationErrors.connectorId, connectorId), inArray(integrationErrors.errorClass, [...BREAKER_CLASSES]), gte(integrationErrors.createdAt, since)))
        .orderBy(desc(integrationErrors.createdAt))
        .limit(50),
    );
    return breakerState(rows.map((r) => r.at), new Date());
  }

  // ── Connector action ────────────────────────────────────────────────────
  async function runConnectorAction(ex: ExecutionRow, st: ExecutionState, node: NodeDef, started: Date): Promise<StepOutcome> {
    const ctx = ctxFor(ex);
    const cfg = NODE_CONFIG_SCHEMAS.connector_action.parse(node.config) as { actionKey: string; input: unknown; retry?: { maxAttempts: number; backoffSeconds: number } };
    let action: ActionWithConnector;
    try {
      action = await loadAction(ex.organizationId, cfg.actionKey);
    } catch (err) {
      return { kind: "error", error: classifyError(err) };
    }
    const scope = scopeFor(ex, st);
    const rawInput = render(cfg.input, scope);
    const { value: input, issues } = validate(parseJsonSchema(action.inputSchema), rawInput ?? {});
    const fail = async (e: ClassifiedError, extra: Partial<typeof integrationExecutionSteps.$inferInsert> = {}) => {
      await recordStep(ex, st, node, { status: "failed", startedAt: started, input: summarizePayload(input, action.capturePayloads), errorClass: e.errorClass, errorMessage: e.message, ...extra });
      await tenant(ex.organizationId, (tx) =>
        tx.insert(integrationErrors).values({ organizationId: ex.organizationId, executionId: ex.id, nodeKey: node.key, connectorId: action.connectorId, actionId: action.id, errorClass: e.errorClass, message: e.message, retryable: e.retryable, attempts: (st.attempts?.[node.key] ?? 0) + 1 }),
      );
      return { kind: "error" as const, error: e };
    };
    if (issues.length) return fail({ errorClass: "validation", retryable: false, message: `Invalid input for ${action.name}: ${issues.map((i) => `${i.path} ${i.message}`).join("; ")}` });

    // Authorization (server-side, as the initiating actor, every time).
    try {
      await authorizer.require(ctx, "integration.execute");
      await authorizer.require(ctx, "integration.connector.use");
      for (const p of action.requiredPermissions) await authorizer.require(ctx, p);
    } catch (err) {
      return fail(classifyError(err));
    }

    // Shared policy → approval gate.
    const decision = await policies.evaluateKind(
      ctx,
      "integration_action",
      {
        subject: { type: ex.actor.type, id: ex.actor.id, attributes: { agentId: ex.agent?.id ?? null, agentVerified: ex.actor.type === "agent" } },
        resource: { type: "integration_action", id: action.key, attributes: { risk: action.risk, operation: action.operation, bridgeType: action.bridgeType, connectorType: action.connectorType, connectorId: action.connectorId, system: action.connectorName } },
        action: `integration.${action.operation}`,
        context: { mode: ex.mode, trigger: ex.trigger, workflowId: ex.workflowId, input },
      },
      { defaultEffect: "ALLOW" },
    );
    const policyDecision = { effect: decision.effect, reasons: decision.reasons.slice(0, 10), policies: decision.policies };
    if (decision.effect === "DENY") return fail({ errorClass: "policy_denied", retryable: false, message: `Denied by policy: ${decision.reasons[0] ?? "no reason given"}` }, { policyDecision });
    const needsApproval = decision.effect === "REQUIRE_APPROVAL" || decision.effect === "ESCALATE" || action.requiresApproval || action.bridgeType === "ui_automation";
    if (needsApproval && ex.mode === "live") {
      const approval = await approvalFor(ex, node.key);
      if (!approval || approval.status === "pending") {
        if (!approval) {
          const tpl = (await import("./templates")).templateByKey(action.templateKey ?? "");
          const affected = Object.fromEntries((tpl?.affectedDataFields ?? Object.keys((input as Record<string, unknown>) ?? {}).slice(0, 6)).map((f) => [f, (input as Record<string, unknown>)?.[f]]));
          await openApproval(ex, node, {
            actionId: action.id, title: `${action.name} on ${action.connectorName}`, system: `${action.connectorName} (${action.connectorType})`,
            reason: action.requiresApproval || action.bridgeType === "ui_automation" ? `"${action.name}" is configured to require human approval${action.bridgeType === "ui_automation" ? " (UI automation)" : ""}.` : `Policy requires approval: ${decision.reasons[0] ?? decision.effect}`,
            risk: action.risk, businessImpact: `${action.operation} via ${action.capability} on ${action.connectorName}`, affectedData: summarizePayload(affected, false), payload: summarizePayload(input, true), policyDecision, expiresHours: 72,
          });
          await recordStep(ex, st, node, { status: "waiting", startedAt: started, input: summarizePayload(input, action.capturePayloads), policyDecision });
        }
        return { kind: "wait", status: "waiting_approval" };
      }
      if (approval.status !== "approved") return fail({ errorClass: "approval_rejected", retryable: false, message: `Approval ${approval.status}${approval.decisionNote ? `: ${approval.decisionNote}` : ""}.` }, { policyDecision });
    }

    // Idempotency: a write that already succeeded in this execution is never sent twice.
    const idempotencyKey = `${ex.id}:${node.key}`;
    const [prior] = await tenant(ex.organizationId, (tx) =>
      tx.select().from(integrationExecutionSteps).where(and(eq(integrationExecutionSteps.executionId, ex.id), eq(integrationExecutionSteps.idempotencyKey, idempotencyKey), inArray(integrationExecutionSteps.status, ["succeeded", "dry_run"]))).limit(1),
    );
    if (prior) return { kind: "next", edge: "next", output: (st.steps ?? {})[node.key] ?? prior.output };

    const params = render(action.requestTemplate, { input, execution: { id: ex.id }, idempotencyKey }) as Record<string, unknown>;
    if (action.kind === "custom" && action.idempotency !== "none") params.headers = { ...((params.headers as Record<string, string>) ?? {}), "Idempotency-Key": idempotencyKey };
    const systemCall = { connectorId: action.connectorId, connector: action.connectorName, connectorType: action.connectorType, capability: action.capability, operation: action.operation, request: summarizePayload(params, action.capturePayloads) };

    // Test sandbox: only simulated connectors are really called.
    if (ex.mode === "test" && action.connectorType !== "sandbox") {
      const output = { dryRun: true, note: "Test mode: request validated but not sent to a real system.", request: systemCall.request };
      await recordStep(ex, st, node, { status: "dry_run", startedAt: started, idempotencyKey, input: summarizePayload(input, true), output, systemCall, policyDecision });
      await bus.publish(ctx, "integration.action.executed", { executionId: ex.id, actionId: action.id, actionKey: action.key, connectorId: action.connectorId, operation: action.operation, mode: ex.mode, dryRun: true });
      return { kind: "next", edge: "next", output };
    }

    const breaker = await breakerFor(ex.organizationId, action.connectorId);
    if (breaker.state === "open") return fail({ errorClass: "circuit_open", retryable: true, retryAfterSeconds: breaker.retryAfterSeconds, message: `Circuit open for ${action.connectorName}: ${breaker.recentFailures} recent failures. Calls pause for ${breaker.retryAfterSeconds}s.` }, { systemCall, policyDecision });
    if (action.rateLimitPerMinute) {
      const rl = await rateLimiter.consume(`integration:action:${action.id}`, { limit: action.rateLimitPerMinute, windowSeconds: 60 });
      if (!rl.allowed) return fail({ errorClass: "rate_limited", retryable: true, retryAfterSeconds: rl.retryAfterSeconds, message: `Action rate limit (${action.rateLimitPerMinute}/min) reached.` }, { systemCall, policyDecision });
    }

    let output: unknown;
    try {
      output = await withTimeout(connectorService.execute(ctx, action.connectorId, { capability: action.capability, operation: action.operation, params }, { moduleId: MODULE_ID }), action.timeoutMs);
    } catch (err) {
      return fail(classifyError(err), { systemCall, policyDecision });
    }
    if (action.outputSchema) {
      const body = action.kind === "custom" && output && typeof output === "object" && "body" in output ? (output as { body: unknown }).body : output;
      const v = validate(parseJsonSchema(action.outputSchema), body);
      if (v.issues.length) return fail({ errorClass: "validation", retryable: false, message: `Response did not match the action's response schema: ${v.issues.slice(0, 3).map((i) => `${i.path} ${i.message}`).join("; ")}` }, { systemCall, policyDecision, output: summarizePayload(output, action.capturePayloads) });
    }
    await recordStep(ex, st, node, { status: "succeeded", startedAt: started, idempotencyKey, input: summarizePayload(input, action.capturePayloads), output: summarizePayload(output, action.capturePayloads), systemCall, policyDecision });
    await tenant(ex.organizationId, (tx) => tx.update(integrationExecutions).set({ systemCalls: sql`${integrationExecutions.systemCalls} + 1` }).where(eq(integrationExecutions.id, ex.id)));
    if (["write", "delete", "execute"].includes(action.operation)) st.succeededWrites = [...(st.succeededWrites ?? []), { nodeKey: node.key, actionId: action.id, input: input as Record<string, unknown>, output }];
    await bus.publish(ctx, "integration.action.executed", { executionId: ex.id, actionId: action.id, actionKey: action.key, connectorId: action.connectorId, operation: action.operation, mode: ex.mode, dryRun: false });
    return { kind: "next", edge: "next", output };
  }

  // ── AI step (shared AI layer only) ──────────────────────────────────────
  async function runAiStep(ex: ExecutionRow, st: ExecutionState, node: NodeDef, started: Date): Promise<StepOutcome> {
    const ctx = ctxFor(ex);
    const cfg = NODE_CONFIG_SCHEMAS.ai_step.parse(node.config) as { instructions: string; input: unknown; outputSchema: JsonSchema; dataClassification: "public" | "internal" | "confidential" | "restricted"; model?: string; maxTokens: number };
    const input = render(cfg.input, scopeFor(ex, st));
    const failed = async (e: ClassifiedError, aiRunId?: string) => {
      await recordStep(ex, st, node, { status: "failed", startedAt: started, input: summarizePayload(input, false), errorClass: e.errorClass, errorMessage: e.message, aiRunId: aiRunId ?? null });
      return { kind: "error" as const, error: e };
    };
    let res: Awaited<ReturnType<AIService["execute"]>>;
    try {
      res = await ai.execute(ctx, {
        moduleId: MODULE_ID,
        useCase: "integration.ai_step",
        system: `${cfg.instructions}\n\nRespond with ONE JSON object matching this JSON schema, nothing else:\n${JSON.stringify(cfg.outputSchema)}`,
        messages: [{ role: "user", content: JSON.stringify({ input }) }],
        responseFormat: "json",
        maxTokens: cfg.maxTokens,
        dataClassification: cfg.dataClassification,
        ...(cfg.model ? { model: cfg.model } : {}),
        promptTemplate: { id: `integration.${ex.workflowId ?? "gateway"}.${node.key}`, version: String(ex.workflowVersion ?? 0) },
        references: { executionId: ex.id, workflowId: ex.workflowId, nodeKey: node.key },
      });
    } catch (err) {
      return failed(classifyError(err));
    }
    let parsed: unknown;
    try {
      const t = res.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
      parsed = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
    } catch {
      return failed({ errorClass: "validation", retryable: false, message: "The AI response was not valid JSON." }, res.runId);
    }
    let simulated = false;
    if ((parsed as { simulated?: unknown })?.simulated === true) {
      if (ex.mode !== "test") return failed({ errorClass: "configuration", retryable: false, message: "Only the simulated AI provider answered. Configure an AI provider to run AI steps live." }, res.runId);
      parsed = sampleFromSchema(cfg.outputSchema);
      simulated = true;
    }
    const v = validate(parseJsonSchema(cfg.outputSchema), parsed);
    if (v.issues.length) return failed({ errorClass: "validation", retryable: false, message: `AI output did not match the step's schema: ${v.issues.slice(0, 3).map((i) => `${i.path} ${i.message}`).join("; ")}` }, res.runId);
    const output = simulated ? { ...(v.value as object), _simulated: true } : v.value;
    await recordStep(ex, st, node, { status: "succeeded", startedAt: started, input: summarizePayload(input, false), output: summarizePayload(output, false), aiRunId: res.runId, costUsd: res.estimatedCostUsd, systemCall: { ai: { model: res.servedModel, provider: res.provider, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, simulated } } });
    await tenant(ex.organizationId, (tx) => tx.update(integrationExecutions).set({ aiCostUsd: sql`${integrationExecutions.aiCostUsd} + ${res.estimatedCostUsd}` }).where(eq(integrationExecutions.id, ex.id)));
    return { kind: "next", edge: "next", output };
  }

  // ── Compensation (best effort; never claimed as a rollback) ─────────────
  async function compensate(ex: ExecutionRow, st: ExecutionState, handler: NodeDef) {
    const ctx = ctxFor(ex);
    const results: Array<{ nodeKey: string; status: "compensated" | "compensation_failed" | "not_reversible"; message?: string }> = [];
    for (const w of [...(st.succeededWrites ?? [])].reverse()) {
      const started = new Date();
      const [a] = await tenant(ex.organizationId, (tx) => tx.select().from(integrationActions).where(eq(integrationActions.id, w.actionId)).limit(1));
      if (!a?.compensation) {
        results.push({ nodeKey: w.nodeKey, status: "not_reversible", message: "No compensating action is configured; the external change remains." });
        continue;
      }
      try {
        const comp = await loadAction(ex.organizationId, a.compensation.actionKey);
        const input = render(a.compensation.inputTemplate, { input: w.input, output: w.output });
        const v = validate(parseJsonSchema(comp.inputSchema), input);
        if (v.issues.length) throw new IntegrationError("validation", v.issues.map((i) => `${i.path} ${i.message}`).join("; "));
        await authorizer.require(ctx, "integration.execute");
        const params = render(comp.requestTemplate, { input: v.value, execution: { id: ex.id }, idempotencyKey: `${ex.id}:${w.nodeKey}:compensate` }) as Record<string, unknown>;
        if (ex.mode === "live" || comp.connectorType === "sandbox") await withTimeout(connectorService.execute(ctx, comp.connectorId, { capability: comp.capability, operation: comp.operation, params }, { moduleId: MODULE_ID }), comp.timeoutMs);
        await recordStep(ex, st, { ...handler, key: `${handler.key}:${w.nodeKey}` }, { status: "compensated", startedAt: started, input: summarizePayload(v.value, false), systemCall: { connectorId: comp.connectorId, capability: comp.capability, operation: comp.operation, compensates: w.nodeKey } });
        results.push({ nodeKey: w.nodeKey, status: "compensated" });
      } catch (err) {
        const e = classifyError(err);
        await recordStep(ex, st, { ...handler, key: `${handler.key}:${w.nodeKey}` }, { status: "compensation_failed", startedAt: started, errorClass: e.errorClass, errorMessage: e.message });
        results.push({ nodeKey: w.nodeKey, status: "compensation_failed", message: e.message });
      }
    }
    st.succeededWrites = (st.succeededWrites ?? []).filter((w) => !results.some((r) => r.nodeKey === w.nodeKey && r.status === "compensated"));
    return results;
  }

  async function runNode(ex: ExecutionRow, st: ExecutionState, node: NodeDef, edges: EdgeDef[]): Promise<StepOutcome> {
    const started = new Date();
    const scope = scopeFor(ex, st);
    switch (node.type) {
      case "trigger":
        await recordStep(ex, st, node, { status: "succeeded", startedAt: started, output: summarizePayload(ex.input, false) });
        return { kind: "next", edge: "next", output: ex.input };
      case "connector_action":
        return runConnectorAction(ex, st, node, started);
      case "ai_step":
        return runAiStep(ex, st, node, started);
      case "transform": {
        const cfg = node.config as { mappings?: Mapping[]; transformationId?: string };
        let mappings: Mapping[];
        if (cfg.transformationId) {
          const [t] = await tenant(ex.organizationId, (tx) => tx.select().from(integrationTransformations).where(and(eq(integrationTransformations.organizationId, ex.organizationId), eq(integrationTransformations.id, cfg.transformationId!))).limit(1));
          if (!t) return { kind: "error", error: { errorClass: "configuration", retryable: false, message: "The referenced transformation no longer exists." } };
          mappings = mappingsSchema.parse(t.mappings);
        } else mappings = mappingsSchema.parse(cfg.mappings);
        const r = applyMappings(mappings, scope);
        if (r.issues.length) {
          const e: ClassifiedError = { errorClass: "validation", retryable: false, message: r.issues.map((i) => `${i.target} ${i.message}`).join("; ") };
          await recordStep(ex, st, node, { status: "failed", startedAt: started, errorClass: e.errorClass, errorMessage: e.message });
          return { kind: "error", error: e };
        }
        await recordStep(ex, st, node, { status: "succeeded", startedAt: started, output: summarizePayload(r.output, false) });
        return { kind: "next", edge: "next", output: r.output };
      }
      case "condition": {
        const cfg = node.config as { condition: never };
        // Evaluated by the SHARED policy engine (same operators as policies).
        const d = policyEngine.evaluate({ combining: "first-match", defaultEffect: "DENY", rules: [{ id: "condition", description: "", effect: "ALLOW", when: cfg.condition }] }, { subject: { type: "execution", id: ex.id }, resource: { type: "workflow" }, action: "condition", context: scope });
        const result = d.effect === "ALLOW";
        await recordStep(ex, st, node, { status: "succeeded", startedAt: started, output: { result, trace: d.reasons } });
        return { kind: "next", edge: result ? "true" : "false", output: { result } };
      }
      case "branch": {
        const value = resolvePath(scope, (node.config as { path: string }).path);
        const caseValue = value === undefined || value === null ? "" : String(value);
        await recordStep(ex, st, node, { status: "succeeded", startedAt: started, output: { value: caseValue, matched: edges.some((e) => e.from === node.key && e.kind === "case" && e.label === caseValue) } });
        return { kind: "next", edge: "case", caseValue, output: { value: caseValue } };
      }
      case "human_approval": {
        const cfg = NODE_CONFIG_SCHEMAS.human_approval.parse(node.config) as { title: string; reason: string; risk: "low" | "medium" | "high" | "critical"; businessImpact?: string; payload: unknown; expiresHours: number };
        if (ex.mode === "test") {
          await recordStep(ex, st, node, { status: "skipped", startedAt: started, output: { note: "Test mode: approval auto-granted (no notification sent)." } });
          return { kind: "next", edge: "next" };
        }
        const approval = await approvalFor(ex, node.key);
        if (!approval) {
          const payload = render(cfg.payload, scope);
          await openApproval(ex, node, { title: cfg.title, reason: cfg.reason, risk: cfg.risk, businessImpact: cfg.businessImpact, payload: summarizePayload(payload, true), affectedData: summarizePayload(payload, false), expiresHours: cfg.expiresHours });
          await recordStep(ex, st, node, { status: "waiting", startedAt: started });
          return { kind: "wait", status: "waiting_approval" };
        }
        if (approval.status === "pending") return { kind: "wait", status: "waiting_approval" };
        const ok = approval.status === "approved";
        await recordStep(ex, st, node, { status: "succeeded", startedAt: started, output: { decision: approval.status, note: approval.decisionNote } });
        if (ok) return { kind: "next", edge: "next", output: { approved: true } };
        if (nextNode(edges, node.key, "rejected")) return { kind: "next", edge: "rejected", output: { approved: false } };
        return { kind: "error", error: { errorClass: "approval_rejected", retryable: false, message: `Approval ${approval.status}${approval.decisionNote ? `: ${approval.decisionNote}` : ""}.` } };
      }
      case "delay": {
        const flag = `delay:${node.key}`;
        if (st.attempts?.[flag]) {
          await recordStep(ex, st, node, { status: "succeeded", startedAt: started });
          return { kind: "next", edge: "next" };
        }
        st.attempts = { ...(st.attempts ?? {}), [flag]: 1 };
        const seconds = (node.config as { seconds: number }).seconds;
        if (ex.mode === "test") {
          await recordStep(ex, st, node, { status: "skipped", startedAt: started, output: { note: `Test mode: ${seconds}s delay skipped.` } });
          return { kind: "next", edge: "next" };
        }
        return { kind: "wait", status: "waiting_delay", runAt: new Date(Date.now() + seconds * 1000) };
      }
      case "retry": {
        const target = nextNode(edges, node.key, "next");
        if (target) st.retryPolicy = { ...(st.retryPolicy ?? {}), [target]: node.config as { maxAttempts: number; backoffSeconds: number } };
        await recordStep(ex, st, node, { status: "succeeded", startedAt: started, output: node.config });
        return { kind: "next", edge: "next" };
      }
      case "exception_handler": {
        const cfg = node.config as { compensate?: boolean; notify?: boolean };
        const comp = cfg.compensate ? await compensate(ex, st, node) : [];
        st.vars = { ...(st.vars ?? {}), handledErrors: ((st.vars?.handledErrors as number) ?? 0) + 1 };
        await recordStep(ex, st, node, { status: "succeeded", startedAt: started, output: { handled: st.lastError, compensation: comp, note: comp.length ? "Best-effort compensation. External systems are not transactional; review any step marked not_reversible or compensation_failed." : undefined } });
        if (cfg.notify !== false && ex.actor.type === "user") {
          await notifications.notify(ctxFor(ex), { type: "integration.execution_failed", title: "Integration step failed and was handled", body: st.lastError?.message, actionUrl: `${BASE}/executions/${ex.id}`, recipients: { userIds: [ex.actor.id] } });
        }
        if (nextNode(edges, node.key, "next")) return { kind: "next", edge: "next" };
        return { kind: "error", error: { errorClass: (st.lastError?.errorClass as ClassifiedError["errorClass"]) ?? "internal", retryable: false, message: `Handled: ${st.lastError?.message ?? "error"}` } };
      }
      case "completion": {
        const output = render((node.config as { output?: unknown }).output ?? {}, scope);
        await recordStep(ex, st, node, { status: "succeeded", startedAt: started, output: summarizePayload(output, false) });
        return { kind: "complete", output };
      }
    }
  }

  async function finish(ex: ExecutionRow, st: ExecutionState, status: "succeeded" | "failed" | "partially_failed", output: unknown, error?: ClassifiedError & { nodeKey?: string }) {
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - (ex.startedAt ?? ex.createdAt).getTime();
    await saveState(ex, st, { status, output: output ?? null, finishedAt, durationMs, currentNode: null, errorClass: error?.errorClass ?? null, errorMessage: error?.message ?? null });
    const ctx = ctxFor(ex);
    await audit.record(ctx, { module: MODULE_ID, action: `integration.execution_${status}`, resourceType: "integration_execution", resourceId: ex.id, outcome: status === "succeeded" ? "success" : "failure", metadata: { workflowId: ex.workflowId, mode: ex.mode, durationMs, errorClass: error?.errorClass } });
    if (status === "succeeded") await bus.publish(ctx, "integration.execution.completed", { executionId: ex.id, workflowId: ex.workflowId, status, durationMs, mode: ex.mode });
    else {
      await bus.publish(ctx, "integration.execution.failed", { executionId: ex.id, workflowId: ex.workflowId, status, errorClass: error?.errorClass ?? "internal", nodeKey: error?.nodeKey ?? null, mode: ex.mode });
      if (ex.actor.type === "user") {
        await notifications.notify(ctx, { type: "integration.execution_failed", title: `Integration ${status === "partially_failed" ? "partially failed" : "failed"}`, body: error?.message, actionUrl: `${BASE}/executions/${ex.id}`, recipients: { userIds: [ex.actor.id] } });
      }
    }
  }

  /** Claim and run an execution until it completes, fails or waits. Safe to call repeatedly (at-least-once jobs). */
  async function run(organizationId: string, executionId: string): Promise<ExecutionRow["status"] | null> {
    const [claimed] = await tenant(organizationId, (tx) =>
      tx
        .update(integrationExecutions)
        .set({ status: "running", startedAt: sql`coalesce(${integrationExecutions.startedAt}, now())` })
        .where(and(eq(integrationExecutions.id, executionId), inArray(integrationExecutions.status, ["queued", "waiting_delay"])))
        .returning(),
    );
    if (!claimed) return null;
    const ex = claimed;
    const st: ExecutionState = structuredClone(ex.state ?? {});
    const first = !ex.state || Object.keys(ex.state).length === 0;
    if (first) await bus.publish(ctxFor(ex), "integration.execution.started", { executionId: ex.id, workflowId: ex.workflowId, actionId: ex.actionId, mode: ex.mode, trigger: ex.trigger, agentId: ex.agent?.id ?? null, agentName: ex.agent?.name ?? null });

    let snapshot: WorkflowSnapshot;
    try {
      snapshot = await loadSnapshot(ex);
    } catch (err) {
      await finish(ex, st, "failed", null, classifyError(err));
      return "failed";
    }
    const nodes = new Map(snapshot.nodes.map((n) => [n.key, n]));
    let key: string | null = st.resumeNode ?? snapshot.nodes.find((n) => n.type === "trigger")?.key ?? null;

    while (key) {
      if ((st.seq ?? 0) >= MAX_STEPS) {
        await finish(ex, st, "failed", null, { errorClass: "internal", retryable: false, message: `Step budget of ${MAX_STEPS} exceeded.` });
        return "failed";
      }
      // Cancellation check between steps.
      const [cur] = await tenant(organizationId, (tx) => tx.select({ status: integrationExecutions.status }).from(integrationExecutions).where(eq(integrationExecutions.id, ex.id)).limit(1));
      if (cur?.status === "cancelled") return "cancelled";
      const node = nodes.get(key);
      if (!node) {
        await finish(ex, st, "failed", null, { errorClass: "configuration", retryable: false, message: `Node "${key}" is missing from the workflow version.` });
        return "failed";
      }
      st.resumeNode = key;
      await saveState(ex, st, { currentNode: key });
      let outcome: StepOutcome;
      try {
        outcome = await runNode(ex, st, node, snapshot.edges);
      } catch (err) {
        logger.error("integration.step_crashed", { executionId: ex.id, node: key, error: err instanceof Error ? err.message : String(err) });
        outcome = { kind: "error", error: classifyError(err) };
      }

      if (outcome.kind === "wait") {
        await saveState(ex, st, { status: outcome.status });
        if (outcome.runAt) await jobs.enqueue(RUN_JOB, { executionId: ex.id }, { organizationId, runAt: outcome.runAt, idempotencyKey: `${ex.id}:${st.seq ?? 0}:${key}:wait` });
        return outcome.status;
      }
      if (outcome.kind === "complete") {
        st.resumeNode = null;
        const handled = ((st.vars?.handledErrors as number) ?? 0) > 0;
        await finish(ex, st, handled ? "partially_failed" : "succeeded", outcome.output, handled && st.lastError ? { ...st.lastError, errorClass: st.lastError.errorClass as ClassifiedError["errorClass"], retryable: false } : undefined);
        return handled ? "partially_failed" : "succeeded";
      }
      if (outcome.kind === "error") {
        const attempt = (st.attempts?.[key] ?? 0) + 1;
        const policy = st.retryPolicy?.[key] ?? (node.type === "connector_action" ? await actionRetry(organizationId, node) : { maxAttempts: 1, backoffSeconds: 1 });
        const decision = decideRetry(outcome.error, attempt, policy);
        if (decision.retry) {
          st.attempts = { ...(st.attempts ?? {}), [key]: attempt };
          await saveState(ex, st, { status: "waiting_delay", errorClass: outcome.error.errorClass, errorMessage: decision.reason });
          await tenant(organizationId, (tx) => tx.update(integrationErrors).set({ status: "retrying" }).where(and(eq(integrationErrors.executionId, ex.id), eq(integrationErrors.nodeKey, key!), eq(integrationErrors.status, "open"))));
          await jobs.enqueue(RUN_JOB, { executionId: ex.id }, { organizationId, runAt: new Date(Date.now() + decision.delaySeconds * 1000), idempotencyKey: `${ex.id}:${key}:retry:${attempt}` });
          return "waiting_delay";
        }
        if (node.type !== "exception_handler") st.lastError = { nodeKey: key, errorClass: outcome.error.errorClass, message: outcome.error.message };
        if (node.type !== "connector_action" && node.type !== "exception_handler") {
          await tenant(organizationId, (tx) =>
            tx.insert(integrationErrors).values({ organizationId, executionId: ex.id, nodeKey: key!, errorClass: outcome.error.errorClass, message: outcome.error.message, retryable: outcome.error.retryable, attempts: attempt }),
          );
        }
        // Exhausted retryable errors go to the dead-letter store; others stay open for review.
        await tenant(organizationId, (tx) =>
          tx.update(integrationErrors).set({ status: outcome.error.retryable ? "dead_letter" : "open", attempts: attempt }).where(and(eq(integrationErrors.executionId, ex.id), eq(integrationErrors.nodeKey, key!), inArray(integrationErrors.status, ["open", "retrying"]))),
        );
        const handler = nextNode(snapshot.edges, key, "error");
        if (handler && node.type !== "exception_handler") {
          key = handler;
          continue;
        }
        st.resumeNode = key;
        const partial = (st.succeededWrites ?? []).length > 0;
        await finish(ex, st, partial ? "partially_failed" : "failed", null, { ...outcome.error, nodeKey: key });
        return partial ? "partially_failed" : "failed";
      }
      if (outcome.output !== undefined) st.steps = { ...(st.steps ?? {}), [key]: outcome.output };
      if (st.attempts?.[key]) st.attempts = { ...st.attempts, [key]: 0 };
      key = nextNode(snapshot.edges, key, outcome.edge, outcome.caseValue);
      if (!key) {
        // A path without a completion node ends successfully with the last output.
        st.resumeNode = null;
        await finish(ex, st, "succeeded", outcome.output ?? null);
        return "succeeded";
      }
    }
    return null;
  }

  async function actionRetry(orgId: string, node: NodeDef) {
    const cfg = node.config as { actionKey?: string; retry?: { maxAttempts: number; backoffSeconds: number } };
    if (cfg.retry) return cfg.retry;
    const [a] = await tenant(orgId, (tx) => tx.select({ retry: integrationActions.retry }).from(integrationActions).where(and(eq(integrationActions.organizationId, orgId), eq(integrationActions.key, cfg.actionKey ?? ""))).limit(1));
    return a?.retry ?? { maxAttempts: 1, backoffSeconds: 1 };
  }

  async function expireApproval(organizationId: string, approvalId: string) {
    const [row] = await tenant(organizationId, (tx) =>
      tx.update(integrationApprovalBindings).set({ status: "expired", decidedAt: new Date(), decisionNote: "Expired without a decision." }).where(and(eq(integrationApprovalBindings.id, approvalId), eq(integrationApprovalBindings.status, "pending"), sql`${integrationApprovalBindings.expiresAt} <= now()`)).returning(),
    );
    if (!row) return;
    const [ex] = await tenant(organizationId, (tx) => tx.update(integrationExecutions).set({ status: "queued" }).where(and(eq(integrationExecutions.id, row.executionId), eq(integrationExecutions.status, "waiting_approval"))).returning());
    if (ex) await run(organizationId, ex.id);
  }

  return { run, expireApproval, loadAction, breakerFor, isTerminal: (s: string) => (TERMINAL_STATUSES as string[]).includes(s) };
}

export type Engine = ReturnType<typeof createEngine>;
