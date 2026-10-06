import { z } from "zod";
import { type ModuleManifest } from "@eaop/module-registry";
import { type ModuleDefinition, type Platform } from "@eaop/platform";
import { textScore } from "@eaop/search";
import { createAiOpsService, DAILY_JOB, MODULE_ID, type AiOpsService } from "./service";

export * from "./service";
export * from "./budget";
export * from "./optimize";
export * from "./policies";
export * from "./requests";
export * from "./economics";
export { COST_DIMENSIONS, type CostLine, type CostDimension } from "./costs";
export { TEMPLATE_SEEDS, USE_CASE_SEEDS, DEPARTMENTS } from "./seeds";
export { BUDGET_SCOPES, COST_BASES, COST_CATEGORIES, REVIEW_STATUSES, TOOL_CATEGORIES, TOOL_STATUSES, VENDOR_REVIEW_STATUSES } from "./schema";

const id = z.string().uuid();
const ev = <S extends z.ZodTypeAny>(type: string, description: string, schema: S) => ({ type, owner: MODULE_ID, version: 1, description, schema });

export const AI_OPS_EVENTS = [
  ev("ai_ops.tool.added", "An AI tool was added to the inventory.", z.object({ toolId: id, status: z.string(), source: z.string() })),
  ev("ai_ops.contract.renewal_due", "A vendor contract entered its renewal notice window.", z.object({ contractId: id, vendorId: id, renewalDate: z.string(), daysUntil: z.number().int(), annualValue: z.number(), autoRenew: z.boolean() })),
  ev("ai_ops.cost.threshold_exceeded", "AI spend crossed a budget alert threshold.", z.object({ budgetId: id, threshold: z.number(), periodKey: z.string(), spent: z.number(), amount: z.number() })),
  ev("ai_ops.request.submitted", "An AI request (tool, automation, model, agent, integration or use case) was submitted.", z.object({ requestId: id, kind: z.string() })),
  ev("ai_ops.request.approved", "An AI request passed every review stage.", z.object({ requestId: id, kind: z.string() })),
  ev("ai_ops.training.required", "AI training was assigned to a person.", z.object({ assignmentId: id, programId: id, userId: id, dueDate: z.string().nullable(), required: z.boolean() })),
  ev("ai_ops.optimization.found", "A new cost-optimization recommendation was found (nothing is changed automatically).", z.object({ findingId: id, kind: z.string(), estimatedAnnualSavings: z.number() })),
];

const ALL = ["ai_ops.read", "ai_ops.tool.manage", "ai_ops.vendor.manage", "ai_ops.cost.read", "ai_ops.cost.manage", "ai_ops.adoption.read", "ai_ops.training.manage", "ai_ops.request.manage", "ai_ops.admin"];

export const manifest: ModuleManifest = {
  id: MODULE_ID,
  name: "AI Operations Management",
  shortName: "AI Operations",
  description: "System of record for the AI estate: tools, vendors, costs, adoption, training, requests and value.",
  version: "1.0.0",
  installStatus: "installed",
  icon: "Gauge",
  basePath: "/m/ai-operations",
  entryPermission: "ai_ops.read",
  permissions: [
    { key: "ai_ops.read", description: "Open AI Operations: approved tools, the use-case library, training and your own AI requests.", risk: "low" },
    { key: "ai_ops.tool.manage", description: "Manage the AI tool inventory, license assignments and license activity.", risk: "high" },
    { key: "ai_ops.vendor.manage", description: "Manage AI vendors, contacts, contracts and renewal dates.", risk: "high" },
    { key: "ai_ops.cost.read", description: "See AI spend, budgets, forecasts, model spend, optimization findings, value and the executive dashboard.", risk: "medium" },
    { key: "ai_ops.cost.manage", description: "Record and allocate costs, manage budgets and value records, and decide optimization findings.", risk: "high" },
    { key: "ai_ops.adoption.read", description: "See department-level AI adoption (small groups are suppressed; never individual activity).", risk: "medium" },
    { key: "ai_ops.training.manage", description: "Manage AI training and the use-case library, assign training and see completion records.", risk: "medium" },
    { key: "ai_ops.request.manage", description: "Review AI requests through the business, security, technical and financial stages.", risk: "high" },
    { key: "ai_ops.admin", description: "Model routing policies, Center of Excellence content, implementation templates and module settings.", risk: "high" },
  ],
  roleGrants: {
    ai_admin: ALL,
    security_admin: ["ai_ops.read", "ai_ops.cost.read", "ai_ops.adoption.read", "ai_ops.request.manage"],
    department_leader: ["ai_ops.read", "ai_ops.cost.read", "ai_ops.adoption.read"],
    analyst: ["ai_ops.read", "ai_ops.cost.read", "ai_ops.adoption.read"],
    auditor: ["ai_ops.read", "ai_ops.cost.read", "ai_ops.adoption.read"],
    standard_user: ["ai_ops.read"],
    read_only: ["ai_ops.read"],
  },
  events: AI_OPS_EVENTS,
  notificationTypes: [
    { key: "ai_ops.renewal_due", description: "An AI contract is entering its renewal notice window.", defaultPriority: "high", channels: ["in_app", "email"] },
    { key: "ai_ops.budget_threshold", description: "AI spend crossed a budget alert threshold.", defaultPriority: "high", channels: ["in_app", "email"] },
    { key: "ai_ops.request", description: "An AI request was submitted, or your request was decided.", defaultPriority: "normal", channels: ["in_app", "email"] },
    { key: "ai_ops.training_required", description: "AI training was assigned to you.", defaultPriority: "normal", channels: ["in_app", "email"] },
    { key: "ai_ops.optimization", description: "New AI cost-optimization recommendations.", defaultPriority: "normal", channels: ["in_app"] },
  ],
  navigation: [
    { label: "Dashboard", href: "/", permission: "ai_ops.read" },
    { label: "Tools", href: "/tools", permission: "ai_ops.read" },
    { label: "Vendors", href: "/vendors", permission: "ai_ops.read" },
    { label: "Costs", href: "/costs", permission: "ai_ops.cost.read" },
    { label: "Optimization", href: "/optimization", permission: "ai_ops.cost.read" },
    { label: "Models", href: "/models", permission: "ai_ops.cost.read" },
    { label: "Adoption", href: "/adoption", permission: "ai_ops.adoption.read" },
    { label: "Enablement", href: "/enablement", permission: "ai_ops.read" },
    { label: "Training", href: "/training", permission: "ai_ops.read" },
    { label: "Requests", href: "/requests", permission: "ai_ops.read" },
    { label: "Center of Excellence", href: "/coe", permission: "ai_ops.read" },
    { label: "Settings", href: "/settings", permission: "ai_ops.admin" },
  ],
};

/** Installed module: service, routing-policy hook, value subscriber, daily job and search on the SHARED core. */
export const aiOperations: ModuleDefinition = {
  manifest,
  install(platform: Platform) {
    const service = createAiOpsService({
      db: platform.db, authorizer: platform.rbac.authorizer, audit: platform.audit, bus: platform.events.bus, notifications: platform.notifications, jobs: platform.jobs,
      modules: platform.modules, insights: platform.insights, logger: platform.logger,
    });
    platform.moduleServices.set(MODULE_ID, service);

    // Business model policies are applied by the shared AI layer (enforced policies only; no-op where the module is off).
    platform.ai.registerRoutingPolicy(MODULE_ID, (candidates, req) => service.route(candidates, req));

    // Realized value flows in from Workflow Intelligence measurements when that module is installed.
    if (platform.events.registry.get("workflow.roi.measured")) {
      platform.events.bus.subscribe("workflow.roi.measured", "ai_operations.value_ledger", async (e) => {
        if (e.organizationId) await service.onWorkflowRoiMeasured(e.organizationId, e.payload as { implementationId: string; workflowId: string; measurementId: string; actualAnnualSavings: number | null });
      });
    }

    platform.jobs.register({ type: DAILY_JOB, maxAttempts: 2, timeoutMs: 60 * 60_000, handle: () => service.runDailyAll() });

    platform.search.register({
      resourceType: "ai_tool",
      owner: MODULE_ID,
      label: "AI tools, vendors and requests",
      permission: "ai_ops.read",
      async search(ctx, q, limit) {
        const rows = await service.search(ctx, q, limit);
        return rows.map((r) => ({ resourceType: `ai_${r.kind}`, id: r.id, title: r.title, subtitle: r.subtitle, url: `/m/ai-operations/${r.kind === "tool" ? "tools" : r.kind === "vendor" ? "vendors" : "requests"}/${r.id}`, score: textScore(q, r.title) }));
      },
    });
  },
};

/** Typed accessor for apps — throws if the module is not installed. */
export function aiOpsService(platform: Pick<Platform, "moduleServices">): AiOpsService {
  const s = platform.moduleServices.get(MODULE_ID) as AiOpsService | undefined;
  if (!s) throw new Error("AI Operations Management module is not installed");
  return s;
}

export default manifest;
