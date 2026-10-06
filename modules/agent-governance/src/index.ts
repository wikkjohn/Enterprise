import { z } from "zod";
import { and, eq, ilike, or } from "@eaop/db";
import { type ModuleManifest } from "@eaop/module-registry";
import { type ModuleDefinition, type Platform } from "@eaop/platform";
import { textScore } from "@eaop/search";
import { agents } from "./schema";
import { APPROVAL_EXPIRE_JOB, createAgentGovernanceService, MODULE_ID, RETENTION_JOB, REVIEW_REMINDER_JOB, type AgentGovernanceService } from "./service";
import { agentInsights } from "./insights";

export * from "./service";
export * from "./decision";
export * from "./risk";
export {
  AGENT_STATUSES, ENVIRONMENTS, AUTONOMY_LEVELS, RISK_LEVELS, ACTION_TYPES, SENSITIVITY, EFFECTS, ACTIVITY_KINDS, REQUEST_STATUSES, APPROVAL_STATUSES,
  type AgentStatus, type Environment, type AutonomyLevel, type ActionType, type Sensitivity, type Effect, type TimeWindow, type ConversationEntry,
} from "./schema";

const id = z.string().uuid();
const ev = <S extends z.ZodTypeAny>(type: string, description: string, schema: S) => ({ type, owner: MODULE_ID, version: 1, description, schema });
const source = z.enum(["direct", "approval", "integration"]);

export const AGENT_EVENTS = [
  ev("agent.registered", "An agent was registered (manually, via API or discovered).", z.object({ agentId: id, name: z.string(), status: z.string(), discoveredVia: z.string() })),
  ev("agent.approved", "An agent was approved to operate.", z.object({ agentId: id, approvedBy: z.string() })),
  ev("agent.suspended", "An emergency control (kill switch) was applied to an agent.", z.object({ agentId: id, action: z.string(), reason: z.string() })),
  ev("agent.action.requested", "An agent requested permission to act.", z.object({ requestId: id, agentId: id, actionType: z.string(), action: z.string(), system: z.string(), decision: z.string() })),
  ev("agent.action.allowed", "An agent action was allowed (by policy or by an approver).", z.object({ requestId: id.nullable(), agentId: id, source })),
  ev("agent.action.denied", "An agent action was denied (by policy or by an approver).", z.object({ requestId: id.nullable(), agentId: id, source, reason: z.string() })),
  ev("agent.approval.required", "An agent action is waiting for human approval.", z.object({ approvalId: id, requestId: id, agentId: id, escalated: z.boolean() })),
  ev("agent.incident.created", "An agent incident was opened.", z.object({ incidentId: id, agentId: id, kind: z.string(), severity: z.string() })),
];

export const manifest: ModuleManifest = {
  id: MODULE_ID,
  name: "AI Agent Governance",
  shortName: "Agent Governance",
  description: "Enterprise control plane for AI agents: inventory, identity, permissions, approvals, kill switch and replay.",
  version: "1.0.0",
  installStatus: "installed",
  icon: "ShieldCheck",
  basePath: "/m/agent-governance",
  entryPermission: "agent.read",
  permissions: [
    { key: "agent.read", description: "View the agent inventory, risk scores, bindings and the security dashboard.", risk: "low" },
    { key: "agent.register", description: "Register new agents (they start pending until approved).", risk: "medium" },
    { key: "agent.manage", description: "Approve agents, edit them, issue credentials, manage permission bindings and decide escalated approvals.", risk: "critical" },
    { key: "agent.suspend", description: "Use the kill switch: suspend, quarantine, revoke credentials, disable capabilities, block connectors.", risk: "critical" },
    { key: "agent.policy.read", description: "View agent policy evaluations and simulate decisions.", risk: "low" },
    { key: "agent.policy.manage", description: "Manage organization policies of kind agent_action (with policy.manage).", risk: "high" },
    { key: "agent.action.read", description: "View agent sessions, action requests and the activity timeline.", risk: "medium" },
    { key: "agent.approval.review", description: "Approve, reject, ask for clarification on, or escalate agent action requests.", risk: "high" },
    { key: "agent.audit.read", description: "Use audit replay across agents, users, systems and incidents.", risk: "medium" },
    { key: "agent.incident.manage", description: "Open, investigate and resolve agent incidents; schedule and complete reviews.", risk: "high" },
  ],
  roleGrants: {
    security_admin: ["agent.read", "agent.suspend", "agent.policy.read", "agent.policy.manage", "agent.action.read", "agent.approval.review", "agent.audit.read", "agent.incident.manage"],
    ai_admin: ["agent.read", "agent.register", "agent.manage", "agent.suspend", "agent.policy.read", "agent.action.read", "agent.approval.review", "agent.incident.manage"],
    auditor: ["agent.read", "agent.policy.read", "agent.action.read", "agent.audit.read"],
    department_leader: ["agent.read", "agent.register", "agent.approval.review", "agent.action.read"],
    analyst: ["agent.read", "agent.register"],
  },
  events: AGENT_EVENTS,
  notificationTypes: [
    { key: "agent.approval_required", description: "An AI agent is waiting for your approval.", defaultPriority: "high", channels: ["in_app", "email"] },
    { key: "agent.emergency", description: "A kill-switch action was applied to an agent.", defaultPriority: "critical", channels: ["in_app", "email"] },
    { key: "agent.incident", description: "An agent incident was opened.", defaultPriority: "high", channels: ["in_app", "email"] },
    { key: "agent.review_due", description: "An agent attestation review is due.", defaultPriority: "normal", channels: ["in_app", "email"] },
  ],
  policyKinds: [
    {
      key: "agent_action",
      description: "Organization rules for AI agent actions. Evaluated after the agent's permission bindings; can only make a decision stricter (ALLOW → REQUIRE_APPROVAL / ESCALATE / DENY). Every evaluation is logged.",
      attributes: {
        "subject.type": "agent",
        "subject.id": "agent id",
        "subject.attributes.name": "agent name, e.g. RefundAgent",
        "subject.attributes.environment": "development | staging | production",
        "subject.attributes.autonomy": "assistive | supervised | semi_autonomous | autonomous",
        "subject.attributes.riskCategory": "low | medium | high | critical",
        "subject.attributes.department": "owning department",
        "resource.type": "system name, e.g. stripe",
        "resource.id": "resource, e.g. Charge/ch_123",
        "resource.attributes.sensitivity": "public | internal | confidential | restricted",
        "resource.attributes.connectorId": "shared connector id or null",
        "action": "business action, e.g. refund",
        "context.actionType": "READ | WRITE | CREATE | UPDATE | DELETE | SEND | EXECUTE | APPROVE | EXPORT",
        "context.amount": "financial amount (number) or null",
        "context.source": "direct | integration | simulation",
        "context.environment": "environment the action targets",
      },
      template: {
        combining: "deny-overrides",
        defaultEffect: "ALLOW",
        rules: [
          { id: "refunds-over-500", description: "RefundAgent refunds over 500 need a human.", effect: "REQUIRE_APPROVAL", actions: ["refund"], when: { all: [{ field: "subject.attributes.name", op: "eq", value: "RefundAgent" }, { field: "context.amount", op: "gt", value: 500 }] } },
          { id: "restricted-data-escalates", description: "Touching restricted data escalates to a manager.", effect: "ESCALATE", when: { field: "resource.attributes.sensitivity", op: "eq", value: "restricted" } },
        ],
      },
    },
  ],
  navigation: [
    { label: "Security dashboard", href: "/", permission: "agent.read" },
    { label: "Agents", href: "/agents", permission: "agent.read" },
    { label: "Approvals", href: "/approvals", permission: "agent.approval.review" },
    { label: "Activity & replay", href: "/activity", permission: "agent.action.read" },
    { label: "Incidents", href: "/incidents", permission: "agent.read" },
    { label: "Reviews", href: "/reviews", permission: "agent.read" },
  ],
};

/** Installed module: service + shared-core extension points (API-key binder, agent actor resolver, Integration interceptor), jobs, discovery and search. */
export const agentGovernance: ModuleDefinition = {
  manifest,
  install(platform: Platform) {
    const service = createAgentGovernanceService({
      db: platform.db, authorizer: platform.rbac.authorizer, audit: platform.audit, bus: platform.events.bus, notifications: platform.notifications,
      policies: platform.policies, policyEngine: platform.policyEngine, apiKeys: platform.apiKeys, secrets: platform.secrets, jobs: platform.jobs,
      organizations: platform.organizations, usage: platform.usage, permissions: platform.rbac.registry, modules: platform.modules, logger: platform.logger,
    });
    platform.moduleServices.set(MODULE_ID, service);
    platform.insights.register(agentInsights(platform));

    // Agent credentials are shared API keys; a key linked to an agent identity authenticates AS the agent.
    platform.apiKeys.registerActorBinder(MODULE_ID, (key) => service.bindApiKey(key));
    // Agent actors only hold permissions while the agent is approved/restricted and not quarantined — suspension takes effect on the next request.
    platform.rbac.authorizer.registerActorResolver("agent", (ctx) => service.resolveAgentPermissions(ctx));
    // Enforce agent bindings inside Integration's policy check without a module dependency.
    platform.policies.registerInterceptor("integration_action", MODULE_ID, async (ctx, req) => {
      if (ctx.actor.type !== "agent" || !(await platform.modules.isEnabled(ctx.organizationId, MODULE_ID))) return null;
      return service.interceptIntegration(ctx, req);
    });

    platform.jobs.register({
      type: APPROVAL_EXPIRE_JOB,
      maxAttempts: 5,
      async handle(job) {
        const { approvalId } = job.payload as { approvalId: string };
        if (job.organizationId) await service.expireApproval(job.organizationId, approvalId);
      },
    });
    platform.jobs.register({
      type: REVIEW_REMINDER_JOB,
      maxAttempts: 3,
      async handle(job) {
        const { reviewId } = job.payload as { reviewId: string };
        if (job.organizationId && (await platform.modules.isEnabled(job.organizationId, MODULE_ID))) await service.remindReview(job.organizationId, reviewId);
      },
    });
    platform.jobs.register({ type: RETENTION_JOB, maxAttempts: 3, timeoutMs: 30 * 60_000, handle: () => service.applyRetention() });

    // Unknown-agent discovery: unverified agent claims on Integration's AI tool gateway.
    platform.events.bus.subscribe("integration.execution.started", "agent_governance.discovery", async (e) => {
      const p = e.payload as { agentId?: string | null; agentName?: string | null };
      if (!e.organizationId || !p.agentId || e.actor?.type === "agent" || !(await platform.modules.isEnabled(e.organizationId, MODULE_ID))) return;
      await service.discoverFromClaim(e.organizationId, { id: p.agentId, ...(p.agentName ? { name: p.agentName } : {}) }, "integration");
    });

    const like = (q: string) => `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    platform.search.register({
      resourceType: "agent",
      owner: MODULE_ID,
      label: "AI agents",
      permission: "agent.read",
      async search(ctx, q, limit) {
        const rows = await platform.db.withTenant({ organizationId: ctx.organizationId }, (tx) =>
          tx.select().from(agents).where(and(eq(agents.organizationId, ctx.organizationId), or(ilike(agents.name, like(q)), ilike(agents.description, like(q)), ilike(agents.businessPurpose, like(q))))).limit(limit),
        );
        return rows.map((a) => ({ resourceType: "agent", id: a.id, title: a.name, subtitle: `Agent · ${a.status} · ${a.environment}`, url: `/m/agent-governance/agents/${a.id}`, score: textScore(q, a.name, a.description) }));
      },
    });
  },
};

/** Typed accessor for apps — throws if the module is not installed. */
export function agentGovernanceService(platform: Pick<Platform, "moduleServices">): AgentGovernanceService {
  const s = platform.moduleServices.get(MODULE_ID) as AgentGovernanceService | undefined;
  if (!s) throw new Error("AI Agent Governance module is not installed");
  return s;
}

export default manifest;
