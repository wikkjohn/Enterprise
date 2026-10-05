import { boolean, date, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { aiRuns, connectors, organizations, users } from "@eaop/db";

/**
 * Drizzle mirror of migrations/0001_workflow_intelligence.sql. The SQL file is
 * the source of truth (it also enables tenant RLS); keep the two in sync.
 */

const id = () => uuid("id").primaryKey().defaultRandom();
const org = () => uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date", precision: 3 });
const userRef = (name: string) => uuid(name).references(() => users.id, { onDelete: "set null" });
const num = (name: string) => numeric(name, { mode: "number" });

export const STEP_TYPES = ["trigger", "human_task", "system_action", "ai_task", "decision", "approval", "delay", "exception", "completion"] as const;
export type StepType = (typeof STEP_TYPES)[number];
export const PROVENANCE = ["fact", "assumption", "ai_estimate"] as const;
export type Provenance = (typeof PROVENANCE)[number];
export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export const WORKFLOW_STATUSES = ["draft", "active", "under_review", "retired"] as const;
export const FREQUENCIES = ["continuous", "daily", "weekly", "monthly", "quarterly", "yearly", "ad_hoc"] as const;
export const DATA_CLASSES = ["production", "sample"] as const;
export type DataClass = (typeof DATA_CLASSES)[number];
export const IMPLEMENTATION_STAGES = ["proposed", "approved", "design", "build", "testing", "pilot", "production", "measured"] as const;
export type ImplementationStage = (typeof IMPLEMENTATION_STAGES)[number];
export const OPPORTUNITY_STATUSES = ["identified", "approved", "rejected", "in_implementation", "delivered"] as const;
export const COST_CATEGORIES = ["implementation", "integration", "software", "ai_inference", "support", "other"] as const;
export const COST_PERIODS = ["one_time", "annual", "per_execution"] as const;

export const wiWorkflows = pgTable("wi_workflows", {
  id: id(),
  organizationId: org(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  department: text("department"),
  ownerUserId: userRef("owner_user_id"),
  ownerName: text("owner_name"),
  businessSponsor: text("business_sponsor"),
  status: text("status", { enum: WORKFLOW_STATUSES }).notNull().default("active"),
  frequency: text("frequency", { enum: FREQUENCIES }).notNull().default("daily"),
  annualVolume: num("annual_volume").notNull().default(0),
  systems: text("systems").array().notNull().default([]),
  roles: text("roles").array().notNull().default([]),
  riskCategory: text("risk_category", { enum: RISK_LEVELS }).notNull().default("medium"),
  regulatoryCategory: text("regulatory_category"),
  source: text("source", { enum: ["manual", "csv", "api", "connector"] }).notNull().default("manual"),
  sourceRef: text("source_ref"),
  connectorId: uuid("connector_id").references(() => connectors.id, { onDelete: "set null" }),
  dataClass: text("data_class", { enum: DATA_CLASSES }).notNull().default("production"),
  currentVersion: integer("current_version").notNull().default(1),
  lastReviewedAt: ts("last_reviewed_at"),
  createdBy: userRef("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const wiWorkflowVersions = pgTable("wi_workflow_versions", {
  id: id(),
  organizationId: org(),
  workflowId: uuid("workflow_id").notNull().references(() => wiWorkflows.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
  changeNote: text("change_note"),
  createdBy: userRef("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const wiWorkflowSteps = pgTable("wi_workflow_steps", {
  id: id(),
  organizationId: org(),
  workflowId: uuid("workflow_id").notNull().references(() => wiWorkflows.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  type: text("type", { enum: STEP_TYPES }).notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  owner: text("owner"),
  role: text("role"),
  system: text("system"),
  input: text("input"),
  output: text("output"),
  durationMinutes: num("duration_minutes").notNull().default(0),
  waitMinutes: num("wait_minutes").notNull().default(0),
  frequencyPerRun: num("frequency_per_run").notNull().default(1),
  costPerExecution: num("cost_per_execution").notNull().default(0),
  errorRate: num("error_rate").notNull().default(0),
  reworkRate: num("rework_rate").notNull().default(0),
  requiresApproval: boolean("requires_approval").notNull().default(false),
  risk: text("risk", { enum: RISK_LEVELS }).notNull().default("low"),
  automationPotential: text("automation_potential", { enum: ["unknown", "none", "low", "medium", "high"] }).notNull().default("unknown"),
  position: jsonb("position").$type<{ x: number; y: number }>().notNull().default({ x: 0, y: 0 }),
  sort: integer("sort").notNull().default(0),
});

export const wiWorkflowEdges = pgTable("wi_workflow_edges", {
  id: id(),
  organizationId: org(),
  workflowId: uuid("workflow_id").notNull().references(() => wiWorkflows.id, { onDelete: "cascade" }),
  fromKey: text("from_key").notNull(),
  toKey: text("to_key").notNull(),
  label: text("label"),
});

export const wiWorkflowMetrics = pgTable("wi_workflow_metrics", {
  workflowId: uuid("workflow_id").primaryKey().references(() => wiWorkflows.id, { onDelete: "cascade" }),
  organizationId: org(),
  employeesInvolved: integer("employees_involved"),
  factors: jsonb("factors").$type<Record<string, { value: number; provenance: Provenance; note?: string }>>().notNull().default({}),
  updatedBy: userRef("updated_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const wiWorkflowCosts = pgTable("wi_workflow_costs", {
  id: id(),
  organizationId: org(),
  workflowId: uuid("workflow_id").notNull().references(() => wiWorkflows.id, { onDelete: "cascade" }),
  category: text("category", { enum: COST_CATEGORIES }).notNull(),
  period: text("period", { enum: COST_PERIODS }).notNull(),
  amount: num("amount").notNull(),
  provenance: text("provenance", { enum: PROVENANCE }).notNull(),
  description: text("description").notNull().default(""),
});

export const wiWorkflowAssumptions = pgTable("wi_workflow_assumptions", {
  id: id(),
  organizationId: org(),
  workflowId: uuid("workflow_id").notNull().references(() => wiWorkflows.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  value: num("value").notNull(),
  provenance: text("provenance", { enum: PROVENANCE }).notNull(),
  rationale: text("rationale").notNull().default(""),
  updatedBy: userRef("updated_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const wiWorkflowScores = pgTable("wi_workflow_scores", {
  id: id(),
  organizationId: org(),
  workflowId: uuid("workflow_id").notNull().references(() => wiWorkflows.id, { onDelete: "cascade" }),
  workflowVersion: integer("workflow_version").notNull(),
  modelVersion: text("model_version").notNull(),
  scores: jsonb("scores").$type<Record<string, unknown>>().notNull(),
  computedBy: userRef("computed_by"),
  computedAt: ts("computed_at").notNull().defaultNow(),
});

export const wiWorkflowRoiCalculations = pgTable("wi_workflow_roi_calculations", {
  id: id(),
  organizationId: org(),
  workflowId: uuid("workflow_id").notNull().references(() => wiWorkflows.id, { onDelete: "cascade" }),
  implementationId: uuid("implementation_id"),
  kind: text("kind", { enum: ["projected", "actual"] }).notNull(),
  inputs: jsonb("inputs").$type<Record<string, unknown>>().notNull(),
  outputs: jsonb("outputs").$type<Record<string, unknown>>().notNull(),
  createdBy: userRef("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const wiWorkflowRecommendations = pgTable("wi_workflow_recommendations", {
  id: id(),
  organizationId: org(),
  workflowId: uuid("workflow_id").notNull().references(() => wiWorkflows.id, { onDelete: "cascade" }),
  workflowVersion: integer("workflow_version").notNull(),
  aiRunId: uuid("ai_run_id").references(() => aiRuns.id, { onDelete: "set null" }),
  promptTemplateId: text("prompt_template_id").notNull(),
  promptTemplateVersion: text("prompt_template_version").notNull(),
  status: text("status", { enum: ["proposed", "accepted", "rejected"] }).notNull().default("proposed"),
  proposal: jsonb("proposal").$type<Record<string, unknown>>().notNull(),
  warnings: text("warnings").array().notNull().default([]),
  createdBy: userRef("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  reviewedBy: userRef("reviewed_by"),
  reviewedAt: ts("reviewed_at"),
  reviewNote: text("review_note"),
});

export const wiWorkflowOpportunities = pgTable("wi_workflow_opportunities", {
  id: id(),
  organizationId: org(),
  workflowId: uuid("workflow_id").notNull().references(() => wiWorkflows.id, { onDelete: "cascade" }),
  status: text("status", { enum: OPPORTUNITY_STATUSES }).notNull().default("identified"),
  valueScore: num("value_score").notNull(),
  complexityScore: num("complexity_score").notNull(),
  riskScore: num("risk_score").notNull(),
  quadrant: text("quadrant").notNull(),
  strategicPriority: integer("strategic_priority").notNull().default(3),
  estimatedAnnualSavings: num("estimated_annual_savings").notNull().default(0),
  potentialRevenue: num("potential_revenue").notNull().default(0),
  implementationCost: num("implementation_cost").notNull().default(0),
  paybackMonths: num("payback_months"),
  roi3yrPct: num("roi_3yr_pct"),
  laborHoursRecoverable: num("labor_hours_recoverable").notNull().default(0),
  createdBy: userRef("created_by"),
  decidedBy: userRef("decided_by"),
  decidedAt: ts("decided_at"),
  decisionNote: text("decision_note"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export interface Milestone {
  name: string;
  dueDate?: string | null;
  done: boolean;
}

export const wiWorkflowImplementations = pgTable("wi_workflow_implementations", {
  id: id(),
  organizationId: org(),
  opportunityId: uuid("opportunity_id").notNull().references(() => wiWorkflowOpportunities.id, { onDelete: "cascade" }),
  workflowId: uuid("workflow_id").notNull().references(() => wiWorkflows.id, { onDelete: "cascade" }),
  stage: text("stage", { enum: IMPLEMENTATION_STAGES }).notNull().default("proposed"),
  sponsor: text("sponsor"),
  owner: text("owner"),
  team: text("team").array().notNull().default([]),
  milestones: jsonb("milestones").$type<Milestone[]>().notNull().default([]),
  dependencies: text("dependencies").array().notNull().default([]),
  systems: text("systems").array().notNull().default([]),
  expectedAnnualSavings: num("expected_annual_savings").notNull().default(0),
  actualCost: num("actual_cost").notNull().default(0),
  deploymentDate: date("deployment_date", { mode: "string" }),
  createdBy: userRef("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const wiWorkflowBaselines = pgTable("wi_workflow_baselines", {
  id: id(),
  organizationId: org(),
  implementationId: uuid("implementation_id").notNull().references(() => wiWorkflowImplementations.id, { onDelete: "cascade" }),
  workflowId: uuid("workflow_id").notNull().references(() => wiWorkflows.id, { onDelete: "cascade" }),
  metrics: jsonb("metrics").$type<Record<string, number>>().notNull(),
  provenance: text("provenance", { enum: PROVENANCE }).notNull(),
  capturedBy: userRef("captured_by"),
  capturedAt: ts("captured_at").notNull().defaultNow(),
});

export const wiWorkflowMeasurements = pgTable("wi_workflow_measurements", {
  id: id(),
  organizationId: org(),
  implementationId: uuid("implementation_id").notNull().references(() => wiWorkflowImplementations.id, { onDelete: "cascade" }),
  workflowId: uuid("workflow_id").notNull().references(() => wiWorkflows.id, { onDelete: "cascade" }),
  periodStart: date("period_start", { mode: "string" }).notNull(),
  periodEnd: date("period_end", { mode: "string" }).notNull(),
  metrics: jsonb("metrics").$type<Record<string, number>>().notNull(),
  provenance: text("provenance", { enum: PROVENANCE }).notNull(),
  note: text("note"),
  createdBy: userRef("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
});
