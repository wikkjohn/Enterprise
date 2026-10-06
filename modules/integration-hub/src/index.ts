import { z } from "zod";
import { and, eq, ilike, or } from "@eaop/db";
import { type ModuleManifest } from "@eaop/module-registry";
import { type ModuleDefinition, type Platform } from "@eaop/platform";
import { textScore } from "@eaop/search";
import { createEngine, EXPIRE_JOB, MODULE_ID, RUN_JOB } from "./engine";
import { integrationActions, integrationWorkflows } from "./schema";
import { createIntegrationService, type IntegrationService } from "./service";

export * from "./service";
export * from "./validation";
export * from "./mapping";
export * from "./graph";
export * from "./reliability";
export * from "./templates";
export { MODULE_ID, gatewaySnapshot, sampleFromSchema } from "./engine";
export { NODE_TYPES, EDGE_KINDS, BRIDGE_TYPES, RISK_LEVELS, EXECUTION_STATUSES, type NodeDef, type EdgeDef, type NodeType, type EdgeKind, type ExecutionState } from "./schema";

const id = z.string().uuid();
const ev = <S extends z.ZodTypeAny>(type: string, description: string, schema: S) => ({ type, owner: MODULE_ID, version: 1, description, schema });

export const INTEGRATION_EVENTS = [
  ev("integration.workflow.created", "An integration workflow was created.", z.object({ workflowId: id, name: z.string() })),
  ev("integration.execution.started", "An execution (workflow run or AI tool call) started.", z.object({ executionId: id, workflowId: id.nullable(), actionId: id.nullable(), mode: z.string(), trigger: z.string() })),
  ev("integration.execution.failed", "An execution failed or partially failed.", z.object({ executionId: id, workflowId: id.nullable(), status: z.string(), errorClass: z.string(), nodeKey: z.string().nullable(), mode: z.string() })),
  ev("integration.execution.completed", "An execution completed successfully.", z.object({ executionId: id, workflowId: id.nullable(), status: z.string(), durationMs: z.number(), mode: z.string() })),
  ev("integration.approval.required", "An action is paused waiting for human approval.", z.object({ approvalId: id, executionId: id, nodeKey: z.string(), risk: z.string(), title: z.string() })),
  ev("integration.action.executed", "A connector action ran (or was dry-run in test mode).", z.object({ executionId: id, actionId: id, actionKey: z.string(), connectorId: id, operation: z.string(), mode: z.string(), dryRun: z.boolean() })),
];

export const manifest: ModuleManifest = {
  id: MODULE_ID,
  name: "Enterprise AI Integration",
  shortName: "Integration",
  description: "Controlled execution layer connecting AI and agents to enterprise systems under policy and approval.",
  version: "1.0.0",
  installStatus: "installed",
  icon: "Cable",
  basePath: "/m/integration-hub",
  entryPermission: "integration.read",
  permissions: [
    { key: "integration.read", description: "View workflows, the action catalog, transformations and approval requests.", risk: "low" },
    { key: "integration.create", description: "Create and edit draft workflows and transformations.", risk: "medium" },
    { key: "integration.manage", description: "Install catalog actions, publish/pause workflows, retry failed executions, resolve dead letters.", risk: "high" },
    { key: "integration.execute", description: "Run workflows and call actions through the AI tool gateway.", risk: "high" },
    { key: "integration.approve", description: "Approve or reject paused actions (never your own executions).", risk: "high" },
    { key: "integration.connector.use", description: "Let integration runs use shared connectors (also needs connector.use).", risk: "high" },
    { key: "integration.history.read", description: "View execution history: inputs, steps, system and AI calls, errors.", risk: "medium" },
    { key: "integration.admin", description: "Build custom actions (endpoint, schemas, headers, legacy bridges).", risk: "critical" },
  ],
  roleGrants: {
    ai_admin: ["integration.read", "integration.create", "integration.manage", "integration.execute", "integration.connector.use", "integration.history.read", "integration.admin"],
    security_admin: ["integration.read", "integration.history.read", "integration.approve"],
    auditor: ["integration.read", "integration.history.read"],
    department_leader: ["integration.read", "integration.execute", "integration.approve", "integration.connector.use", "integration.history.read"],
    analyst: ["integration.read", "integration.create", "integration.execute", "integration.connector.use", "integration.history.read"],
    standard_user: ["integration.read"],
    read_only: ["integration.read"],
  },
  events: INTEGRATION_EVENTS,
  notificationTypes: [
    { key: "integration.approval_required", description: "An integration action is waiting for your approval.", defaultPriority: "high", channels: ["in_app", "email"] },
    { key: "integration.execution_failed", description: "An integration you started failed or partially failed.", defaultPriority: "normal", channels: ["in_app", "email"] },
  ],
  policyKinds: [
    {
      key: "integration_action",
      description: "Decides whether an integration action may run, must be approved, or is denied. Evaluated before every connector call (workflows and AI tool gateway).",
      attributes: {
        "subject.type": "user | api_key | agent | system",
        "subject.attributes.agentId": "agent id (verified for agent actors, claimed for API keys)",
        "resource.id": "action key",
        "resource.attributes.risk": "low | medium | high | critical",
        "resource.attributes.operation": "read | list | search | write | delete | execute",
        "resource.attributes.bridgeType": "native | api_wrapper | database | sftp | rpa | ui_automation",
        "resource.attributes.connectorType": "shared connector type, e.g. salesforce",
        "context.mode": "live | test",
        "context.trigger": "manual | api | event | gateway",
        "context.input": "validated action input",
      },
      template: {
        combining: "deny-overrides",
        defaultEffect: "ALLOW",
        rules: [
          { id: "critical-needs-approval", description: "Critical-risk actions need a human.", effect: "REQUIRE_APPROVAL", when: { field: "resource.attributes.risk", op: "eq", value: "critical" } },
          { id: "agents-writes-need-approval", description: "Writes requested by AI agents need a human.", effect: "REQUIRE_APPROVAL", actions: ["integration.write", "integration.delete"], when: { field: "subject.type", op: "eq", value: "agent" } },
        ],
      },
    },
  ],
  navigation: [
    { label: "Overview", href: "/", permission: "integration.read" },
    { label: "Workflows", href: "/workflows", permission: "integration.read" },
    { label: "Action catalog", href: "/actions", permission: "integration.read" },
    { label: "Approvals", href: "/approvals", permission: "integration.read" },
    { label: "Executions", href: "/executions", permission: "integration.history.read" },
    { label: "Developers", href: "/developers", permission: "integration.read" },
  ],
};

/** Installed module: engine + service on the SHARED core; jobs, event triggers and search registered here. */
export const integrationHub: ModuleDefinition = {
  manifest,
  install(platform: Platform) {
    const engine = createEngine({
      db: platform.db, authorizer: platform.rbac.authorizer, audit: platform.audit, bus: platform.events.bus, notifications: platform.notifications, ai: platform.ai,
      connectors: platform.connectors, jobs: platform.jobs, policies: platform.policies, policyEngine: platform.policyEngine, rateLimiter: platform.rateLimiter, logger: platform.logger,
    });
    const service = createIntegrationService({
      db: platform.db, authorizer: platform.rbac.authorizer, audit: platform.audit, bus: platform.events.bus, connectors: platform.connectors, jobs: platform.jobs,
      permissions: platform.rbac.registry, eventRegistry: platform.events.registry, engine,
    });
    platform.moduleServices.set(MODULE_ID, service);

    platform.jobs.register({
      type: RUN_JOB,
      maxAttempts: 5,
      timeoutMs: 15 * 60_000,
      async handle(job) {
        const { executionId } = job.payload as { executionId: string };
        if (job.organizationId && (await platform.modules.isEnabled(job.organizationId, MODULE_ID))) await engine.run(job.organizationId, executionId);
      },
    });
    platform.jobs.register({
      type: EXPIRE_JOB,
      maxAttempts: 5,
      async handle(job) {
        const { approvalId } = job.payload as { approvalId: string };
        if (job.organizationId) await engine.expireApproval(job.organizationId, approvalId);
      },
    });
    platform.events.bus.subscribe("*", "integration_hub.event_triggers", async (e) => {
      if (!e.organizationId || e.type.startsWith("integration.") || !(await platform.modules.isEnabled(e.organizationId, MODULE_ID))) return;
      await service.onEvent({ id: e.id, type: e.type, organizationId: e.organizationId, payload: e.payload, occurredAt: e.occurredAt, correlationId: e.correlationId });
    });

    const like = (q: string) => `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    platform.search.register({
      resourceType: "integration_workflow",
      owner: MODULE_ID,
      label: "Integration workflows",
      permission: "integration.read",
      async search(ctx, q, limit) {
        const rows = await platform.db.withTenant({ organizationId: ctx.organizationId }, (tx) =>
          tx.select().from(integrationWorkflows).where(and(eq(integrationWorkflows.organizationId, ctx.organizationId), or(ilike(integrationWorkflows.name, like(q)), ilike(integrationWorkflows.description, like(q))))).limit(limit),
        );
        return rows.map((w) => ({ resourceType: "integration_workflow", id: w.id, title: w.name, subtitle: `Workflow · ${w.status}`, url: `/m/integration-hub/workflows/${w.id}`, score: textScore(q, w.name, w.description) }));
      },
    });
    platform.search.register({
      resourceType: "integration_action",
      owner: MODULE_ID,
      label: "Integration actions",
      permission: "integration.read",
      async search(ctx, q, limit) {
        const rows = await platform.db.withTenant({ organizationId: ctx.organizationId }, (tx) =>
          tx.select().from(integrationActions).where(and(eq(integrationActions.organizationId, ctx.organizationId), or(ilike(integrationActions.name, like(q)), ilike(integrationActions.key, like(q))))).limit(limit),
        );
        return rows.map((a) => ({ resourceType: "integration_action", id: a.id, title: a.name, subtitle: `${a.key} · ${a.risk} risk`, url: `/m/integration-hub/actions/${a.id}`, score: textScore(q, a.name, a.key) }));
      },
    });
  },
};

/** Typed accessor for apps — throws if the module is not installed. */
export function integrationService(platform: Pick<Platform, "moduleServices">): IntegrationService {
  const s = platform.moduleServices.get(MODULE_ID) as IntegrationService | undefined;
  if (!s) throw new Error("Enterprise AI Integration module is not installed");
  return s;
}

export default manifest;
