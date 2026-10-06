import { boolean, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { apiKeysMetadata, connectors, organizations, users } from "@eaop/db";

/**
 * Drizzle mirror of migrations/0001_agent_governance.sql (the SQL is the
 * source of truth and also enables tenant RLS).
 */

const id = () => uuid("id").primaryKey().defaultRandom();
const org = () => uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date", precision: 3 });
const userRef = (name: string) => uuid(name).references(() => users.id, { onDelete: "set null" });
const agentRef = () => uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" });

export const AGENT_STATUSES = ["unknown", "pending", "approved", "restricted", "suspended", "retired"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];
export const ENVIRONMENTS = ["development", "staging", "production"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];
export const AUTONOMY_LEVELS = ["assistive", "supervised", "semi_autonomous", "autonomous"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];
export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type Risk = (typeof RISK_LEVELS)[number];
export const ACTION_TYPES = ["READ", "WRITE", "CREATE", "UPDATE", "DELETE", "SEND", "EXECUTE", "APPROVE", "EXPORT"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];
export const SENSITIVITY = ["public", "internal", "confidential", "restricted"] as const;
export type Sensitivity = (typeof SENSITIVITY)[number];
export const EFFECTS = ["ALLOW", "DENY", "REQUIRE_APPROVAL", "ESCALATE"] as const;
export type Effect = (typeof EFFECTS)[number];
export const ACTIVITY_KINDS = ["instruction", "tool_call", "system_access", "resource_access", "action_proposed", "policy_decision", "approval", "action_executed", "error", "output", "emergency"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export const REQUEST_STATUSES = ["allowed", "denied", "pending_approval", "approved", "rejected", "clarification_requested", "escalated", "executed", "failed", "expired", "cancelled"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "clarification_requested", "escalated", "expired", "cancelled"] as const;

export interface TimeWindow {
  /** ISO weekdays 1 (Mon) … 7 (Sun). */
  days: number[];
  startHour: number;
  endHour: number;
  /** IANA time zone, default UTC. */
  timeZone?: string;
}

export const agents = pgTable("agents", {
  id: id(),
  organizationId: org(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  externalId: text("external_id"),
  ownerUserId: userRef("owner_user_id"),
  department: text("department"),
  businessPurpose: text("business_purpose").notNull().default(""),
  environment: text("environment", { enum: ENVIRONMENTS }).notNull().default("development"),
  status: text("status", { enum: AGENT_STATUSES }).notNull().default("pending"),
  quarantined: boolean("quarantined").notNull().default(false),
  provider: text("provider"),
  model: text("model"),
  autonomyLevel: text("autonomy_level", { enum: AUTONOMY_LEVELS }).notNull().default("supervised"),
  riskCategory: text("risk_category", { enum: RISK_LEVELS }).notNull().default("medium"),
  connectedSystems: text("connected_systems").array().notNull().default([]),
  blockedConnectorIds: uuid("blocked_connector_ids").array().notNull().default([]),
  customerImpact: integer("customer_impact"),
  regulatoryImpact: integer("regulatory_impact"),
  discoveredVia: text("discovered_via", { enum: ["manual", "api", "integration"] }).notNull().default("manual"),
  currentVersion: integer("current_version").notNull().default(1),
  lastActivityAt: ts("last_activity_at"),
  lastReviewAt: ts("last_review_at"),
  approvedBy: userRef("approved_by"),
  approvedAt: ts("approved_at"),
  createdBy: userRef("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const agentVersions = pgTable("agent_versions", {
  id: id(),
  organizationId: org(),
  agentId: agentRef(),
  version: integer("version").notNull(),
  snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
  changeNote: text("change_note"),
  createdBy: userRef("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const agentIdentities = pgTable("agent_identities", {
  id: id(),
  organizationId: org(),
  agentId: agentRef(),
  kind: text("kind", { enum: ["api_key", "oauth_client", "certificate", "external"] }).notNull(),
  status: text("status", { enum: ["active", "revoked", "expired"] }).notNull().default("active"),
  apiKeyId: uuid("api_key_id").references(() => apiKeysMetadata.id, { onDelete: "set null" }),
  secretRef: text("secret_ref"),
  fingerprint: text("fingerprint"),
  issuer: text("issuer"),
  subject: text("subject"),
  scopes: text("scopes").array().notNull().default([]),
  environment: text("environment", { enum: ENVIRONMENTS }).notNull(),
  expiresAt: ts("expires_at"),
  lastUsedAt: ts("last_used_at"),
  revokedAt: ts("revoked_at"),
  revokedBy: userRef("revoked_by"),
  createdBy: userRef("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const agentPermissionBindings = pgTable("agent_permission_bindings", {
  id: id(),
  organizationId: org(),
  agentId: agentRef(),
  actionType: text("action_type", { enum: ACTION_TYPES }).notNull(),
  system: text("system").notNull().default("*"),
  connectorId: uuid("connector_id").references(() => connectors.id, { onDelete: "cascade" }),
  resource: text("resource").notNull().default("*"),
  environment: text("environment", { enum: ["any", ...ENVIRONMENTS] }).notNull().default("any"),
  maxDataSensitivity: text("max_data_sensitivity", { enum: SENSITIVITY }).notNull().default("internal"),
  financialLimit: numeric("financial_limit", { mode: "number" }),
  timeWindow: jsonb("time_window").$type<TimeWindow | null>(),
  conditions: jsonb("conditions").$type<unknown>(),
  requiresApproval: boolean("requires_approval").notNull().default(false),
  status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
  description: text("description").notNull().default(""),
  expiresAt: ts("expires_at"),
  createdBy: userRef("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const agentSessions = pgTable("agent_sessions", {
  id: id(),
  organizationId: org(),
  agentId: agentRef(),
  externalRef: text("external_ref"),
  onBehalfOfUserId: userRef("on_behalf_of_user_id"),
  instruction: text("instruction"),
  status: text("status", { enum: ["active", "completed", "failed", "terminated"] }).notNull().default("active"),
  startedAt: ts("started_at").notNull().defaultNow(),
  endedAt: ts("ended_at"),
  lastEventAt: ts("last_event_at").notNull().defaultNow(),
});

export const agentActions = pgTable("agent_actions", {
  id: id(),
  organizationId: org(),
  agentId: agentRef(),
  sessionId: uuid("session_id").references(() => agentSessions.id, { onDelete: "cascade" }),
  requestId: uuid("request_id"),
  kind: text("kind", { enum: ACTIVITY_KINDS }).notNull(),
  source: text("source", { enum: ["agent", "platform", "integration"] }).notNull().default("agent"),
  system: text("system"),
  resource: text("resource"),
  actionType: text("action_type"),
  decision: text("decision"),
  summary: text("summary").notNull(),
  detail: jsonb("detail").$type<unknown>(),
  occurredAt: ts("occurred_at").notNull().defaultNow(),
});

export const agentActionRequests = pgTable("agent_action_requests", {
  id: id(),
  organizationId: org(),
  agentId: agentRef(),
  sessionId: uuid("session_id").references(() => agentSessions.id, { onDelete: "set null" }),
  actionType: text("action_type").notNull(),
  action: text("action").notNull(),
  system: text("system").notNull(),
  connectorId: uuid("connector_id").references(() => connectors.id, { onDelete: "set null" }),
  resource: text("resource").notNull().default("*"),
  environment: text("environment").notNull(),
  dataSensitivity: text("data_sensitivity").notNull(),
  amount: numeric("amount", { mode: "number" }),
  currency: text("currency"),
  context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}),
  decision: text("decision", { enum: EFFECTS }).notNull(),
  status: text("status", { enum: REQUEST_STATUSES }).notNull(),
  reasons: text("reasons").array().notNull().default([]),
  bindingId: uuid("binding_id").references(() => agentPermissionBindings.id, { onDelete: "set null" }),
  idempotencyKey: text("idempotency_key"),
  result: jsonb("result").$type<unknown>(),
  executedAt: ts("executed_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const agentPolicyEvaluations = pgTable("agent_policy_evaluations", {
  id: id(),
  organizationId: org(),
  agentId: agentRef(),
  requestId: uuid("request_id").references(() => agentActionRequests.id, { onDelete: "set null" }),
  source: text("source", { enum: ["direct", "integration", "simulation"] }).notNull(),
  input: jsonb("input").$type<Record<string, unknown>>().notNull(),
  effect: text("effect", { enum: EFFECTS }).notNull(),
  reasons: text("reasons").array().notNull().default([]),
  matchedBindings: uuid("matched_bindings").array().notNull().default([]),
  policies: jsonb("policies").$type<unknown[]>().notNull().default([]),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export interface ConversationEntry {
  at: string;
  by: string;
  role: "approver" | "agent";
  kind: "clarification_request" | "clarification" | "escalation" | "decision";
  message: string;
}

export const agentApprovals = pgTable("agent_approvals", {
  id: id(),
  organizationId: org(),
  requestId: uuid("request_id").notNull().references(() => agentActionRequests.id, { onDelete: "cascade" }),
  agentId: agentRef(),
  status: text("status", { enum: APPROVAL_STATUSES }).notNull().default("pending"),
  reason: text("reason").notNull(),
  affectedSystems: text("affected_systems").array().notNull().default([]),
  affectedRecords: jsonb("affected_records").$type<unknown>(),
  financialImpact: numeric("financial_impact", { mode: "number" }),
  dataSensitivity: text("data_sensitivity").notNull(),
  policy: jsonb("policy").$type<Record<string, unknown>>().notNull(),
  supportingContext: jsonb("supporting_context").$type<unknown>(),
  escalationLevel: integer("escalation_level").notNull().default(0),
  conversation: jsonb("conversation").$type<ConversationEntry[]>().notNull().default([]),
  decidedBy: userRef("decided_by"),
  decidedAt: ts("decided_at"),
  decisionNote: text("decision_note"),
  expiresAt: ts("expires_at").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const agentRiskAssessments = pgTable("agent_risk_assessments", {
  id: id(),
  organizationId: org(),
  agentId: agentRef(),
  modelVersion: text("model_version").notNull(),
  score: numeric("score", { mode: "number" }).notNull(),
  band: text("band").notNull(),
  components: jsonb("components").$type<unknown[]>().notNull(),
  explanation: text("explanation").notNull(),
  computedBy: userRef("computed_by"),
  computedAt: ts("computed_at").notNull().defaultNow(),
});

export const agentIncidents = pgTable("agent_incidents", {
  id: id(),
  organizationId: org(),
  agentId: agentRef(),
  kind: text("kind", { enum: ["kill_switch", "policy_violation", "manual"] }).notNull(),
  severity: text("severity", { enum: RISK_LEVELS }).notNull(),
  status: text("status", { enum: ["open", "investigating", "resolved"] }).notNull().default("open"),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  actionsTaken: jsonb("actions_taken").$type<Array<{ action: string; at: string; by: string; detail?: string }>>().notNull().default([]),
  relatedRequestId: uuid("related_request_id").references(() => agentActionRequests.id, { onDelete: "set null" }),
  openedBy: userRef("opened_by"),
  resolvedBy: userRef("resolved_by"),
  resolvedAt: ts("resolved_at"),
  resolution: text("resolution"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const agentReviews = pgTable("agent_reviews", {
  id: id(),
  organizationId: org(),
  agentId: agentRef(),
  reviewOwnerUserId: userRef("review_owner_user_id"),
  agentOwnerUserId: userRef("agent_owner_user_id"),
  dueAt: ts("due_at").notNull(),
  status: text("status", { enum: ["scheduled", "completed", "cancelled"] }).notNull().default("scheduled"),
  purposeValid: boolean("purpose_valid"),
  permissionsValid: boolean("permissions_valid"),
  systemsRequired: boolean("systems_required"),
  riskStatus: text("risk_status"),
  outcome: text("outcome", { enum: ["approved", "changes_required", "restricted", "retired"] }),
  notes: text("notes"),
  completedBy: userRef("completed_by"),
  completedAt: ts("completed_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});
