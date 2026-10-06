import { z } from "zod";
import { type ModuleManifest } from "@eaop/module-registry";
import { type ModuleDefinition, type Platform } from "@eaop/platform";
import { textScore } from "@eaop/search";
import { createWorkflowService, MODULE_ID, workflowSearch, type WorkflowService } from "./service";
import { workflowInsights } from "./insights";

export * from "./service";
export * from "./roi";
export * from "./scoring";
export * from "./csv";
export * from "./redesign";
export { STEP_TYPES, PROVENANCE, IMPLEMENTATION_STAGES, DATA_CLASSES, COST_CATEGORIES, COST_PERIODS, FREQUENCIES, RISK_LEVELS, WORKFLOW_STATUSES, OPPORTUNITY_STATUSES, type StepType, type Provenance, type DataClass, type ImplementationStage } from "./schema";

const dataClass = z.enum(["production", "sample"]);
const ev = <S extends z.ZodTypeAny>(type: string, description: string, schema: S) => ({ type, owner: MODULE_ID, version: 1, description, schema });

export const WORKFLOW_EVENTS = [
  ev("workflow.created", "A workflow was added to the inventory (manual, CSV, API or connector).", z.object({ workflowId: z.string().uuid(), name: z.string(), source: z.string(), dataClass })),
  ev("workflow.analyzed", "A workflow was scored and its ROI projected.", z.object({
    workflowId: z.string().uuid(), version: z.number().int(), modelVersion: z.string(), quadrant: z.string(), aiReady: z.boolean(), dataClass,
    scores: z.object({ aiOpportunity: z.number(), automationReadiness: z.number(), dataReadiness: z.number(), risk: z.number(), integrationComplexity: z.number(), expectedRoi: z.number() }),
  })),
  ev("workflow.opportunity.created", "An AI opportunity was identified from an analysis.", z.object({ opportunityId: z.string().uuid(), workflowId: z.string().uuid(), valueScore: z.number(), quadrant: z.string(), dataClass })),
  ev("workflow.approved", "An AI opportunity was approved for implementation.", z.object({ opportunityId: z.string().uuid(), workflowId: z.string().uuid(), decidedBy: z.string(), dataClass })),
  ev("workflow.implementation.started", "Implementation tracking started for an opportunity.", z.object({ implementationId: z.string().uuid(), opportunityId: z.string().uuid(), workflowId: z.string().uuid(), stage: z.string(), dataClass })),
  ev("workflow.production.started", "An implementation reached production.", z.object({ implementationId: z.string().uuid(), workflowId: z.string().uuid(), deploymentDate: z.string(), dataClass })),
  ev("workflow.roi.measured", "A post-deployment measurement was recorded and realized ROI recomputed.", z.object({ implementationId: z.string().uuid(), workflowId: z.string().uuid(), measurementId: z.string().uuid(), actualAnnualSavings: z.number().nullable(), dataClass })),
];

export const manifest: ModuleManifest = {
  id: MODULE_ID,
  name: "AI Workflow Intelligence",
  shortName: "Workflow Intelligence",
  description: "Find, score and redesign the workflows where AI creates measurable value, and track realized ROI.",
  version: "1.0.0",
  installStatus: "installed",
  icon: "Workflow",
  basePath: "/m/workflow-intelligence",
  entryPermission: "workflow.read",
  permissions: [
    { key: "workflow.read", description: "View the workflow inventory, models, scores, opportunities and implementations.", risk: "low" },
    { key: "workflow.create", description: "Add workflows manually or by CSV, API or connector import.", risk: "low" },
    { key: "workflow.update", description: "Edit workflow attributes, process models and factor ratings.", risk: "low" },
    { key: "workflow.delete", description: "Delete workflows and clear sample data.", risk: "high" },
    { key: "workflow.analyze", description: "Run scoring, ROI projection and AI redesign (AI calls also need ai.use).", risk: "medium" },
    { key: "workflow.approve", description: "Approve or reject opportunities and AI redesign proposals.", risk: "high" },
    { key: "workflow.roi.read", description: "See financial figures: costs, savings, revenue, ROI and payback.", risk: "medium" },
    { key: "workflow.roi.manage", description: "Edit ROI assumptions and costs; record baselines and measurements.", risk: "high" },
    { key: "workflow.implementation.manage", description: "Start implementations and move them through stages.", risk: "high" },
  ],
  roleGrants: {
    executive: ["workflow.read", "workflow.roi.read"],
    department_leader: ["workflow.read", "workflow.create", "workflow.update", "workflow.analyze", "workflow.approve", "workflow.roi.read", "workflow.implementation.manage"],
    analyst: ["workflow.read", "workflow.create", "workflow.update", "workflow.analyze", "workflow.roi.read", "workflow.roi.manage"],
    auditor: ["workflow.read", "workflow.roi.read"],
    standard_user: ["workflow.read"],
    read_only: ["workflow.read"],
  },
  events: WORKFLOW_EVENTS,
  notificationTypes: [
    { key: "workflow.opportunity_identified", description: "A high-value AI opportunity is awaiting a decision.", defaultPriority: "normal", channels: ["in_app", "email"] },
    { key: "workflow.opportunity_decided", description: "An opportunity you identified was approved or rejected.", defaultPriority: "normal", channels: ["in_app"] },
    { key: "workflow.implementation_production", description: "An implementation reached production and needs ROI measurements.", defaultPriority: "normal", channels: ["in_app", "email"] },
  ],
  navigation: [
    { label: "Dashboard", href: "/", permission: "workflow.read" },
    { label: "Inventory", href: "/workflows", permission: "workflow.read" },
    { label: "Opportunities", href: "/opportunities", permission: "workflow.read" },
    { label: "Implementations", href: "/implementations", permission: "workflow.read" },
  ],
};

/** Installed module: builds the service on the SHARED core and registers search. */
export const workflowIntelligence: ModuleDefinition = {
  manifest,
  install(platform: Platform) {
    const service = createWorkflowService({
      db: platform.db,
      authorizer: platform.rbac.authorizer,
      audit: platform.audit,
      bus: platform.events.bus,
      notifications: platform.notifications,
      ai: platform.ai,
      connectors: platform.connectors,
    });
    platform.moduleServices.set(MODULE_ID, service);
    platform.insights.register(workflowInsights(platform));
    const search = workflowSearch(platform.db);
    platform.search.register({
      resourceType: "workflow",
      owner: MODULE_ID,
      label: "Workflows",
      permission: "workflow.read",
      async search(ctx, q, limit) {
        return (await search(ctx, q, limit)).map((h) => ({ resourceType: "workflow", ...h, score: textScore(q, h.title, h.subtitle) }));
      },
    });
  },
};

/** Typed accessor for apps (web/worker) — throws if the module is not installed. */
export function workflowService(platform: Pick<Platform, "moduleServices">): WorkflowService {
  const s = platform.moduleServices.get(MODULE_ID) as WorkflowService | undefined;
  if (!s) throw new Error("Workflow Intelligence module is not installed");
  return s;
}

export default manifest;
