import { boolean, date, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations, users } from "@eaop/db";
import { type ModelPolicyMatch, type ModelPolicyRules } from "./policies";
import { type RequestKind, type RequestStage } from "./requests";

/** Drizzle mirror of migrations/0001_ai_operations.sql (the SQL is the source of truth and enables tenant RLS). */

const id = () => uuid("id").primaryKey().defaultRandom();
const org = () => uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date", precision: 3 });
const userRef = (name: string) => uuid(name).references(() => users.id, { onDelete: "set null" });
const money = (name: string) => numeric(name, { precision: 14, scale: 2, mode: "number" });
const day = (name: string) => date(name, { mode: "string" });

export const TOOL_STATUSES = ["strategic", "approved", "experimental", "restricted", "retiring"] as const;
export type ToolStatus = (typeof TOOL_STATUSES)[number];
export const REVIEW_STATUSES = ["not_started", "in_progress", "approved", "conditional", "rejected"] as const;
export const VENDOR_REVIEW_STATUSES = ["not_reviewed", "in_review", "approved", "conditional", "rejected"] as const;
export const COST_CATEGORIES = ["subscription", "api", "inference", "cloud", "implementation", "consulting", "support"] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];
export const COST_BASES = ["measured", "estimated", "allocated"] as const;
export type CostBasis = (typeof COST_BASES)[number];
export const BUDGET_SCOPES = ["organization", "department", "tool", "vendor", "provider", "model", "category", "project"] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];
export const TOOL_CATEGORIES = ["chat_assistant", "coding_assistant", "writing_assistant", "meeting_assistant", "search_knowledge", "analytics", "image_media", "customer_service", "sales", "model_api", "agent_platform", "automation", "other"] as const;
export const CLASSIFICATION = ["public", "internal", "confidential", "restricted"] as const;
export type Classification = (typeof CLASSIFICATION)[number];

export const aiOpsSettings = pgTable("ai_ops_settings", {
  organizationId: uuid("organization_id").primaryKey().references(() => organizations.id, { onDelete: "cascade" }),
  fiscalYearStartMonth: integer("fiscal_year_start_month").notNull().default(1),
  renewalNoticeDays: integer("renewal_notice_days").notNull().default(90),
  unusedLicenseDays: integer("unused_license_days").notNull().default(30),
  costSpikePct: integer("cost_spike_pct").notNull().default(50),
  contractUtilizationFloorPct: integer("contract_utilization_floor_pct").notNull().default(60),
  adoptionMinGroup: integer("adoption_min_group").notNull().default(5),
  seededAt: ts("seeded_at"),
  updatedBy: userRef("updated_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export interface VendorContact { name: string; email?: string; role?: string; phone?: string }

export const aiVendors = pgTable("ai_vendors", {
  id: id(),
  organizationId: org(),
  name: text("name").notNull(),
  website: text("website"),
  platformProviderKeys: text("platform_provider_keys").array().notNull().default([]),
  businessOwnerUserId: userRef("business_owner_user_id"),
  contacts: jsonb("contacts").$type<VendorContact[]>().notNull().default([]),
  securityStatus: text("security_status").$type<(typeof VENDOR_REVIEW_STATUSES)[number]>().notNull().default("not_reviewed"),
  privacyStatus: text("privacy_status").$type<(typeof VENDOR_REVIEW_STATUSES)[number]>().notNull().default("not_reviewed"),
  securityReviewedAt: ts("security_reviewed_at"),
  privacyReviewedAt: ts("privacy_reviewed_at"),
  status: text("status").$type<"active" | "inactive">().notNull().default("active"),
  notes: text("notes").notNull().default(""),
  createdBy: userRef("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const aiVendorContracts = pgTable("ai_vendor_contracts", {
  id: id(),
  organizationId: org(),
  vendorId: uuid("vendor_id").notNull().references(() => aiVendors.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  contractNumber: text("contract_number"),
  status: text("status").$type<"draft" | "active" | "expired" | "terminated">().notNull().default("active"),
  startDate: day("start_date"),
  endDate: day("end_date"),
  renewalDate: day("renewal_date"),
  autoRenew: boolean("auto_renew").notNull().default(false),
  noticeDays: integer("notice_days").notNull().default(30),
  annualValue: money("annual_value").notNull().default(0),
  committedAnnualSpend: money("committed_annual_spend").notNull().default(0),
  billingFrequency: text("billing_frequency").$type<"monthly" | "quarterly" | "annual" | "usage">().notNull().default("annual"),
  ownerUserId: userRef("owner_user_id"),
  documentUrl: text("document_url"),
  notes: text("notes").notNull().default(""),
  renewalAlertedFor: day("renewal_alerted_for"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const aiTools = pgTable("ai_tools", {
  id: id(),
  organizationId: org(),
  name: text("name").notNull(),
  vendorId: uuid("vendor_id").references(() => aiVendors.id, { onDelete: "set null" }),
  contractId: uuid("contract_id").references(() => aiVendorContracts.id, { onDelete: "set null" }),
  category: text("category").notNull().default("other"),
  purpose: text("purpose").notNull().default(""),
  status: text("status").$type<ToolStatus>().notNull().default("experimental"),
  businessOwnerUserId: userRef("business_owner_user_id"),
  departments: text("departments").array().notNull().default([]),
  licensedSeats: integer("licensed_seats").notNull().default(0),
  annualCost: money("annual_cost").notNull().default(0),
  renewalDate: day("renewal_date"),
  securityReview: text("security_review").$type<(typeof REVIEW_STATUSES)[number]>().notNull().default("not_started"),
  privacyReview: text("privacy_review").$type<(typeof REVIEW_STATUSES)[number]>().notNull().default("not_started"),
  maxDataClassification: text("max_data_classification").$type<Classification>().notNull().default("internal"),
  platformProviderKey: text("platform_provider_key"),
  platformModelKeys: text("platform_model_keys").array().notNull().default([]),
  relatedModules: text("related_modules").array().notNull().default([]),
  usageKey: text("usage_key"),
  website: text("website"),
  source: text("source").$type<"manual" | "request" | "data_security" | "import">().notNull().default("manual"),
  requestId: uuid("request_id"),
  createdBy: userRef("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const aiToolLicenses = pgTable("ai_tool_licenses", {
  id: id(),
  organizationId: org(),
  toolId: uuid("tool_id").notNull().references(() => aiTools.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  status: text("status").$type<"active" | "revoked">().notNull().default("active"),
  source: text("source").$type<"manual" | "import" | "sso" | "request">().notNull().default("manual"),
  assignedAt: ts("assigned_at").notNull().defaultNow(),
  lastActiveAt: ts("last_active_at"),
  activityDays30: integer("activity_days_30").notNull().default(0),
  revokedAt: ts("revoked_at"),
});

export const aiCostRecords = pgTable("ai_cost_records", {
  id: id(),
  organizationId: org(),
  periodStart: day("period_start").notNull(),
  periodEnd: day("period_end").notNull(),
  amountUsd: money("amount_usd").notNull(),
  category: text("category").$type<CostCategory>().notNull(),
  basis: text("basis").$type<CostBasis>().notNull(),
  source: text("source").$type<"manual" | "import" | "api" | "allocation">().notNull().default("manual"),
  status: text("status").$type<"active" | "allocated" | "void">().notNull().default("active"),
  description: text("description").notNull().default(""),
  toolId: uuid("tool_id").references(() => aiTools.id, { onDelete: "set null" }),
  vendorId: uuid("vendor_id").references(() => aiVendors.id, { onDelete: "set null" }),
  contractId: uuid("contract_id").references(() => aiVendorContracts.id, { onDelete: "set null" }),
  department: text("department"),
  providerKey: text("provider_key"),
  modelKey: text("model_key"),
  agentId: text("agent_id"),
  workflowId: text("workflow_id"),
  project: text("project"),
  userId: userRef("user_id"),
  parentId: uuid("parent_id"),
  externalRef: text("external_ref"),
  createdBy: userRef("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const aiBudgets = pgTable("ai_budgets", {
  id: id(),
  organizationId: org(),
  name: text("name").notNull(),
  scope: text("scope").$type<BudgetScope>().notNull(),
  scopeValue: text("scope_value"),
  period: text("period").$type<"monthly" | "quarterly" | "annual">().notNull(),
  amountUsd: money("amount_usd").notNull(),
  thresholds: integer("thresholds").array().notNull().default([80, 100]),
  ownerUserId: userRef("owner_user_id"),
  status: text("status").$type<"active" | "archived">().notNull().default("active"),
  alerted: jsonb("alerted").$type<Record<string, number[]>>().notNull().default({}),
  createdBy: userRef("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const aiCostForecasts = pgTable("ai_cost_forecasts", {
  id: id(),
  organizationId: org(),
  scope: text("scope").notNull().default("organization"),
  scopeValue: text("scope_value"),
  month: day("month").notNull(),
  method: text("method").notNull(),
  forecastUsd: money("forecast_usd").notNull(),
  lowUsd: money("low_usd").notNull(),
  highUsd: money("high_usd").notNull(),
  note: text("note").notNull().default(""),
  generatedAt: ts("generated_at").notNull().defaultNow(),
});

export const aiAdoptionMetrics = pgTable("ai_adoption_metrics", {
  id: id(),
  organizationId: org(),
  period: text("period").notNull(),
  department: text("department").notNull(),
  members: integer("members").notNull().default(0),
  licensedUsers: integer("licensed_users").notNull().default(0),
  activeUsers: integer("active_users").notNull().default(0),
  aiRuns: integer("ai_runs").notNull().default(0),
  trainingRequired: integer("training_required").notNull().default(0),
  trainingCompleted: integer("training_completed").notNull().default(0),
  useCaseUsers: jsonb("use_case_users").$type<Record<string, number>>().notNull().default({}),
  computedAt: ts("computed_at").notNull().defaultNow(),
});

export const aiTrainingPrograms = pgTable("ai_training_programs", {
  id: id(),
  organizationId: org(),
  parentId: uuid("parent_id"),
  kind: text("kind").$type<"program" | "course">().notNull().default("course"),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  workflowFocus: text("workflow_focus").notNull().default(""),
  departments: text("departments").array().notNull().default([]),
  roles: text("roles").array().notNull().default([]),
  required: boolean("required").notNull().default(false),
  validityDays: integer("validity_days"),
  passScore: integer("pass_score"),
  contentUrl: text("content_url"),
  status: text("status").$type<"draft" | "active" | "retired">().notNull().default("active"),
  createdBy: userRef("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const aiUseCases = pgTable("ai_use_cases", {
  id: id(),
  organizationId: org(),
  department: text("department").notNull(),
  title: text("title").notNull(),
  businessProblem: text("business_problem").notNull().default(""),
  approvedWorkflow: text("approved_workflow").notNull().default(""),
  toolId: uuid("tool_id").references(() => aiTools.id, { onDelete: "set null" }),
  instructions: text("instructions").notNull().default(""),
  expectedBenefit: text("expected_benefit").notNull().default(""),
  risks: text("risks").notNull().default(""),
  requiredTrainingId: uuid("required_training_id").references(() => aiTrainingPrograms.id, { onDelete: "set null" }),
  successMetric: text("success_metric").notNull().default(""),
  workflowRef: text("workflow_ref"),
  usageKey: text("usage_key"),
  templateId: uuid("template_id"),
  status: text("status").$type<"draft" | "published" | "retired">().notNull().default("draft"),
  ownerUserId: userRef("owner_user_id"),
  createdBy: userRef("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const aiTrainingAssignments = pgTable("ai_training_assignments", {
  id: id(),
  organizationId: org(),
  programId: uuid("program_id").notNull().references(() => aiTrainingPrograms.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  department: text("department"),
  role: text("role"),
  required: boolean("required").notNull().default(false),
  status: text("status").$type<"assigned" | "in_progress" | "completed" | "expired" | "waived">().notNull().default("assigned"),
  dueDate: day("due_date"),
  completedAt: ts("completed_at"),
  score: integer("score"),
  passed: boolean("passed"),
  expiresAt: ts("expires_at"),
  assignedBy: userRef("assigned_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const aiRequests = pgTable("ai_requests", {
  id: id(),
  organizationId: org(),
  kind: text("kind").$type<RequestKind>().notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  businessJustification: text("business_justification").notNull().default(""),
  department: text("department"),
  requesterUserId: userRef("requester_user_id"),
  stage: text("stage").$type<RequestStage>().notNull().default("submitted"),
  changesRequested: boolean("changes_requested").notNull().default(false),
  dataClassification: text("data_classification").$type<Classification>().notNull().default("internal"),
  estimatedAnnualCost: money("estimated_annual_cost").notNull().default(0),
  expectedAnnualValue: money("expected_annual_value").notNull().default(0),
  vendorName: text("vendor_name"),
  assigneeUserId: userRef("assignee_user_id"),
  toolId: uuid("tool_id").references(() => aiTools.id, { onDelete: "set null" }),
  outcome: text("outcome"),
  closedReason: text("closed_reason"),
  submittedAt: ts("submitted_at").notNull().defaultNow(),
  decidedAt: ts("decided_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const aiRequestReviews = pgTable("ai_request_reviews", {
  id: id(),
  organizationId: org(),
  requestId: uuid("request_id").notNull().references(() => aiRequests.id, { onDelete: "cascade" }),
  stage: text("stage").notNull(),
  action: text("action").notNull(),
  decision: text("decision"),
  fromStage: text("from_stage").notNull(),
  toStage: text("to_stage").notNull(),
  reviewerUserId: userRef("reviewer_user_id"),
  actorLabel: text("actor_label").notNull(),
  notes: text("notes").notNull().default(""),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const aiImplementationTemplates = pgTable("ai_implementation_templates", {
  id: id(),
  organizationId: org(),
  key: text("key"),
  name: text("name").notNull(),
  category: text("category").notNull().default("other"),
  businessObjective: text("business_objective").notNull().default(""),
  systems: text("systems").array().notNull().default([]),
  data: text("data").notNull().default(""),
  aiCapability: text("ai_capability").notNull().default(""),
  riskLevel: text("risk_level").$type<"low" | "medium" | "high">().notNull().default("medium"),
  risks: text("risks").notNull().default(""),
  implementation: text("implementation").array().notNull().default([]),
  measurement: text("measurement").array().notNull().default([]),
  workflowRefs: text("workflow_refs").array().notNull().default([]),
  status: text("status").$type<"draft" | "published" | "retired">().notNull().default("draft"),
  createdBy: userRef("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const aiValueRecords = pgTable("ai_value_records", {
  id: id(),
  organizationId: org(),
  kind: text("kind").$type<"realized" | "projected">().notNull(),
  basis: text("basis").$type<"measured" | "estimated">().notNull(),
  annualValueUsd: money("annual_value_usd").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  sourceModule: text("source_module").notNull().default("ai_operations"),
  sourceRef: text("source_ref"),
  department: text("department"),
  toolId: uuid("tool_id").references(() => aiTools.id, { onDelete: "set null" }),
  useCaseId: uuid("use_case_id").references(() => aiUseCases.id, { onDelete: "set null" }),
  requestId: uuid("request_id").references(() => aiRequests.id, { onDelete: "set null" }),
  recordedAt: ts("recorded_at").notNull().defaultNow(),
  createdBy: userRef("created_by"),
});

export const aiModelPolicies = pgTable("ai_model_policies", {
  id: id(),
  organizationId: org(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  priority: integer("priority").notNull().default(100),
  enforcement: text("enforcement").$type<"advisory" | "enforced">().notNull().default("advisory"),
  status: text("status").$type<"active" | "disabled">().notNull().default("active"),
  match: jsonb("match").$type<ModelPolicyMatch>().notNull(),
  rules: jsonb("rules").$type<ModelPolicyRules>().notNull(),
  regulatoryNote: text("regulatory_note"),
  createdBy: userRef("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const aiOptimizationFindings = pgTable("ai_optimization_findings", {
  id: id(),
  organizationId: org(),
  kind: text("kind").notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  title: text("title").notNull(),
  detail: text("detail").notNull(),
  recommendation: text("recommendation").notNull(),
  severity: text("severity").$type<"low" | "medium" | "high">().notNull(),
  estimatedAnnualSavings: money("estimated_annual_savings").notNull().default(0),
  toolId: uuid("tool_id"),
  vendorId: uuid("vendor_id"),
  contractId: uuid("contract_id"),
  modelKey: text("model_key"),
  evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default({}),
  status: text("status").$type<"open" | "accepted" | "dismissed" | "resolved">().notNull().default("open"),
  note: text("note"),
  decidedBy: userRef("decided_by"),
  firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
  lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
});

export const aiCoeItems = pgTable("ai_coe_items", {
  id: id(),
  organizationId: org(),
  kind: text("kind").$type<"standard" | "policy" | "guidance" | "best_practice">().notNull(),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  ownerUserId: userRef("owner_user_id"),
  status: text("status").$type<"draft" | "published" | "retired">().notNull().default("draft"),
  reviewDate: day("review_date"),
  createdBy: userRef("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
