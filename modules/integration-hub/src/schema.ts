import { boolean, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { aiRuns, connectors, organizations, users } from "@eaop/db";

/**
 * Drizzle mirror of migrations/0001_integration_hub.sql. The SQL file is the
 * source of truth (it also enables tenant RLS); keep the two in sync.
 */

const id = () => uuid("id").primaryKey().defaultRandom();
const org = () => uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date", precision: 3 });
const userRef = (name: string) => uuid(name).references(() => users.id, { onDelete: "set null" });

export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type Risk = (typeof RISK_LEVELS)[number];
export const ACTION_OPERATIONS = ["read", "list", "search", "write", "delete", "execute"] as const;
export type ActionOperation = (typeof ACTION_OPERATIONS)[number];
export const BRIDGE_TYPES = ["native", "api_wrapper", "database", "sftp", "rpa", "ui_automation"] as const;
export type BridgeType = (typeof BRIDGE_TYPES)[number];
export const NODE_TYPES = ["trigger", "connector_action", "ai_step", "transform", "condition", "human_approval", "delay", "retry", "branch", "exception_handler", "completion"] as const;
export type NodeType = (typeof NODE_TYPES)[number];
export const EDGE_KINDS = ["next", "true", "false", "error", "case", "rejected", "exhausted"] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];
export const EXECUTION_STATUSES = ["queued", "running", "waiting_approval", "waiting_delay", "succeeded", "failed", "partially_failed", "cancelled"] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];
export const TERMINAL_STATUSES: ExecutionStatus[] = ["succeeded", "failed", "partially_failed", "cancelled"];
export const WORKFLOW_STATUSES = ["draft", "active", "paused", "archived"] as const;
export const TRIGGER_TYPES = ["manual", "api", "event"] as const;

export interface StoredActor {
  type: "user" | "api_key" | "system" | "agent";
  id: string;
  label: string;
  scopes?: string[];
}

export interface RetryPolicy {
  maxAttempts: number;
  backoffSeconds: number;
}

export const integrationActions = pgTable("integration_actions", {
  id: id(),
  organizationId: org(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  connectorId: uuid("connector_id").notNull().references(() => connectors.id, { onDelete: "cascade" }),
  capability: text("capability").notNull(),
  operation: text("operation", { enum: ACTION_OPERATIONS }).notNull(),
  kind: text("kind", { enum: ["catalog", "custom"] }).notNull().default("catalog"),
  templateKey: text("template_key"),
  bridgeType: text("bridge_type", { enum: BRIDGE_TYPES }).notNull().default("native"),
  inputSchema: jsonb("input_schema").$type<Record<string, unknown>>().notNull(),
  outputSchema: jsonb("output_schema").$type<Record<string, unknown> | null>(),
  requestTemplate: jsonb("request_template").$type<Record<string, unknown>>().notNull(),
  requiredPermissions: text("required_permissions").array().notNull().default([]),
  risk: text("risk", { enum: RISK_LEVELS }).notNull(),
  requiresApproval: boolean("requires_approval").notNull().default(false),
  idempotency: text("idempotency", { enum: ["none", "auto", "key_required"] }).notNull().default("none"),
  timeoutMs: integer("timeout_ms").notNull().default(30000),
  rateLimitPerMinute: integer("rate_limit_per_minute"),
  retry: jsonb("retry").$type<RetryPolicy>().notNull().default({ maxAttempts: 3, backoffSeconds: 10 }),
  compensation: jsonb("compensation").$type<{ actionKey: string; inputTemplate: Record<string, unknown> } | null>(),
  capturePayloads: boolean("capture_payloads").notNull().default(false),
  aiExposed: boolean("ai_exposed").notNull().default(false),
  status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
  createdBy: userRef("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const integrationTransformations = pgTable("integration_transformations", {
  id: id(),
  organizationId: org(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  mappings: jsonb("mappings").$type<unknown[]>().notNull(),
  createdBy: userRef("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const integrationWorkflows = pgTable("integration_workflows", {
  id: id(),
  organizationId: org(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  status: text("status", { enum: WORKFLOW_STATUSES }).notNull().default("draft"),
  triggerType: text("trigger_type", { enum: TRIGGER_TYPES }).notNull().default("manual"),
  triggerConfig: jsonb("trigger_config").$type<{ eventType?: string }>().notNull().default({}),
  inputSchema: jsonb("input_schema").$type<Record<string, unknown> | null>(),
  isSample: boolean("is_sample").notNull().default(false),
  currentVersion: integer("current_version").notNull().default(1),
  publishedVersion: integer("published_version"),
  runAsUserId: userRef("run_as_user_id"),
  createdBy: userRef("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const integrationWorkflowVersions = pgTable("integration_workflow_versions", {
  id: id(),
  organizationId: org(),
  workflowId: uuid("workflow_id").notNull().references(() => integrationWorkflows.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  snapshot: jsonb("snapshot").$type<WorkflowSnapshot>().notNull(),
  changeNote: text("change_note"),
  createdBy: userRef("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export interface NodeDef {
  key: string;
  type: NodeType;
  name: string;
  config: Record<string, unknown>;
  position: { x: number; y: number };
}
export interface EdgeDef {
  from: string;
  to: string;
  kind: EdgeKind;
  label?: string | null;
}
export interface WorkflowSnapshot {
  name: string;
  description: string;
  triggerType: string;
  triggerConfig: Record<string, unknown>;
  inputSchema: Record<string, unknown> | null;
  nodes: NodeDef[];
  edges: EdgeDef[];
}

export const integrationNodes = pgTable("integration_nodes", {
  id: id(),
  organizationId: org(),
  workflowId: uuid("workflow_id").notNull().references(() => integrationWorkflows.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  type: text("type", { enum: NODE_TYPES }).notNull(),
  name: text("name").notNull(),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  position: jsonb("position").$type<{ x: number; y: number }>().notNull().default({ x: 0, y: 0 }),
  sort: integer("sort").notNull().default(0),
});

export const integrationEdges = pgTable("integration_edges", {
  id: id(),
  organizationId: org(),
  workflowId: uuid("workflow_id").notNull().references(() => integrationWorkflows.id, { onDelete: "cascade" }),
  fromKey: text("from_key").notNull(),
  toKey: text("to_key").notNull(),
  kind: text("kind", { enum: EDGE_KINDS }).notNull().default("next"),
  label: text("label"),
});

export const integrationExecutions = pgTable("integration_executions", {
  id: id(),
  organizationId: org(),
  workflowId: uuid("workflow_id").references(() => integrationWorkflows.id, { onDelete: "set null" }),
  workflowVersion: integer("workflow_version"),
  actionId: uuid("action_id").references(() => integrationActions.id, { onDelete: "set null" }),
  mode: text("mode", { enum: ["live", "test"] }).notNull().default("live"),
  trigger: text("trigger", { enum: ["manual", "api", "event", "gateway"] }).notNull(),
  status: text("status", { enum: EXECUTION_STATUSES }).notNull().default("queued"),
  idempotencyKey: text("idempotency_key"),
  input: jsonb("input").$type<Record<string, unknown>>().notNull().default({}),
  state: jsonb("state").$type<ExecutionState>().notNull().default({} as ExecutionState),
  output: jsonb("output").$type<unknown>(),
  currentNode: text("current_node"),
  actor: jsonb("actor").$type<StoredActor>().notNull(),
  agent: jsonb("agent").$type<{ id: string; name?: string } | null>(),
  errorClass: text("error_class"),
  errorMessage: text("error_message"),
  aiCostUsd: numeric("ai_cost_usd", { mode: "number" }).notNull().default(0),
  systemCalls: integer("system_calls").notNull().default(0),
  correlationId: text("correlation_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
  startedAt: ts("started_at"),
  finishedAt: ts("finished_at"),
  durationMs: integer("duration_ms"),
});

/** Persisted run state: outputs by node, retry bookkeeping, compensation log. */
export interface ExecutionState {
  steps?: Record<string, unknown>;
  vars?: Record<string, unknown>;
  attempts?: Record<string, number>;
  retryPolicy?: Record<string, { maxAttempts: number; backoffSeconds: number }>;
  succeededWrites?: Array<{ nodeKey: string; actionId: string; input: Record<string, unknown>; output: unknown }>;
  lastError?: { nodeKey: string; errorClass: string; message: string } | null;
  seq?: number;
  resumeNode?: string | null;
}

export const integrationExecutionSteps = pgTable("integration_execution_steps", {
  id: id(),
  organizationId: org(),
  executionId: uuid("execution_id").notNull().references(() => integrationExecutions.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),
  nodeKey: text("node_key").notNull(),
  nodeType: text("node_type").notNull(),
  attempt: integer("attempt").notNull().default(1),
  status: text("status", { enum: ["succeeded", "failed", "skipped", "waiting", "compensated", "compensation_failed", "dry_run"] }).notNull(),
  idempotencyKey: text("idempotency_key"),
  input: jsonb("input").$type<unknown>(),
  output: jsonb("output").$type<unknown>(),
  systemCall: jsonb("system_call").$type<Record<string, unknown> | null>(),
  aiRunId: uuid("ai_run_id").references(() => aiRuns.id, { onDelete: "set null" }),
  policyDecision: jsonb("policy_decision").$type<Record<string, unknown> | null>(),
  errorClass: text("error_class"),
  errorMessage: text("error_message"),
  costUsd: numeric("cost_usd", { mode: "number" }).notNull().default(0),
  startedAt: ts("started_at").notNull().defaultNow(),
  finishedAt: ts("finished_at"),
  durationMs: integer("duration_ms"),
});

export const integrationApprovalBindings = pgTable("integration_approval_bindings", {
  id: id(),
  organizationId: org(),
  executionId: uuid("execution_id").notNull().references(() => integrationExecutions.id, { onDelete: "cascade" }),
  nodeKey: text("node_key").notNull(),
  actionId: uuid("action_id").references(() => integrationActions.id, { onDelete: "set null" }),
  status: text("status", { enum: ["pending", "approved", "rejected", "expired", "cancelled"] }).notNull().default("pending"),
  title: text("title").notNull(),
  system: text("system"),
  reason: text("reason").notNull(),
  risk: text("risk", { enum: RISK_LEVELS }).notNull(),
  businessImpact: text("business_impact"),
  affectedData: jsonb("affected_data").$type<unknown>(),
  proposedPayload: jsonb("proposed_payload").$type<unknown>(),
  policyDecision: jsonb("policy_decision").$type<Record<string, unknown> | null>(),
  requestedBy: jsonb("requested_by").$type<StoredActor>().notNull(),
  decidedBy: userRef("decided_by"),
  decidedAt: ts("decided_at"),
  decisionNote: text("decision_note"),
  expiresAt: ts("expires_at").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const integrationErrors = pgTable("integration_errors", {
  id: id(),
  organizationId: org(),
  executionId: uuid("execution_id").references(() => integrationExecutions.id, { onDelete: "cascade" }),
  nodeKey: text("node_key"),
  connectorId: uuid("connector_id").references(() => connectors.id, { onDelete: "set null" }),
  actionId: uuid("action_id").references(() => integrationActions.id, { onDelete: "set null" }),
  errorClass: text("error_class").notNull(),
  message: text("message").notNull(),
  retryable: boolean("retryable").notNull().default(false),
  attempts: integer("attempts").notNull().default(1),
  status: text("status", { enum: ["open", "retrying", "dead_letter", "resolved"] }).notNull().default("open"),
  resolvedBy: userRef("resolved_by"),
  resolvedAt: ts("resolved_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});
