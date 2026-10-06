import { bigint, boolean, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { connectors, organizations, users } from "@eaop/db";

/**
 * Drizzle mirror of migrations/0001_data_security.sql (the SQL is the source
 * of truth and also enables tenant RLS).
 */

const id = () => uuid("id").primaryKey().defaultRandom();
const org = () => uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date", precision: 3 });
const userRef = (name: string) => uuid(name).references(() => users.id, { onDelete: "set null" });

export type SensitivityLevel = "public" | "internal" | "confidential" | "restricted";
export type SeverityLevel = "low" | "medium" | "high" | "critical";
export type Decision = "ALLOW" | "REDACT" | "REQUIRE_APPROVAL" | "BLOCK";

export const dsSettings = pgTable("data_security_settings", {
  organizationId: uuid("organization_id").primaryKey().references(() => organizations.id, { onDelete: "cascade" }),
  contentRetention: text("content_retention").$type<"none" | "redacted_preview">().notNull().default("redacted_preview"),
  largeExportChars: integer("large_export_chars").notNull().default(100000),
  abnormalBlockedPerHour: integer("abnormal_blocked_per_hour").notNull().default(5),
  broadGroupSize: integer("broad_group_size").notNull().default(500),
  tokenizationSecretRef: text("tokenization_secret_ref"),
  updatedBy: userRef("updated_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const classificationRules = pgTable("data_classification_rules", {
  id: id(),
  organizationId: org(),
  key: text("key").notNull(),
  builtin: boolean("builtin").notNull().default(false),
  label: text("label").notNull(),
  description: text("description").notNull().default(""),
  sensitivity: text("sensitivity").$type<SensitivityLevel>().notNull().default("confidential"),
  patterns: text("patterns").array().notNull().default([]),
  keywords: text("keywords").array().notNull().default([]),
  confidence: text("confidence").$type<"low" | "medium" | "high">().notNull().default("medium"),
  actionApproved: text("action_approved").$type<Decision>().notNull(),
  actionUnapproved: text("action_unapproved").$type<Decision>().notNull(),
  minConfidence: text("min_confidence").$type<"low" | "medium" | "high">().notNull().default("medium"),
  redactionMode: text("redaction_mode").$type<"mask" | "tokenize" | "label">().notNull().default("label"),
  enabled: boolean("enabled").notNull().default(true),
  createdBy: userRef("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const dataScans = pgTable("data_scans", {
  id: id(),
  organizationId: org(),
  connectorId: uuid("connector_id").references(() => connectors.id, { onDelete: "set null" }),
  source: text("source").$type<"connector" | "api">().notNull(),
  status: text("status").$type<"queued" | "running" | "succeeded" | "failed">().notNull().default("queued"),
  params: jsonb("params").$type<Record<string, unknown>>().notNull().default({}),
  assetsSeen: integer("assets_seen").notNull().default(0),
  assetsClassified: integer("assets_classified").notNull().default(0),
  findingsOpened: integer("findings_opened").notNull().default(0),
  errorMessage: text("error_message"),
  requestedBy: userRef("requested_by"),
  startedAt: ts("started_at"),
  finishedAt: ts("finished_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const dataAssets = pgTable("data_assets", {
  id: id(),
  organizationId: org(),
  connectorId: uuid("connector_id").references(() => connectors.id, { onDelete: "set null" }),
  sourceSystem: text("source_system").notNull(),
  externalId: text("external_id").notNull(),
  name: text("name").notNull(),
  assetType: text("asset_type").notNull().default("file"),
  location: text("location").notNull().default(""),
  ownerUserId: userRef("owner_user_id"),
  ownerLabel: text("owner_label"),
  department: text("department"),
  classification: text("classification").$type<SensitivityLevel>().notNull().default("internal"),
  classificationLocked: boolean("classification_locked").notNull().default(false),
  categories: text("categories").array().notNull().default([]),
  permissions: jsonb("permissions").$type<Record<string, unknown>>().notNull().default({ scope: "private" }),
  sharingScope: text("sharing_scope").$type<"private" | "specific" | "group" | "organization" | "public">().notNull().default("private"),
  lastModifiedAt: ts("last_modified_at"),
  lastAccessedAt: ts("last_accessed_at"),
  retentionCategory: text("retention_category"),
  aiExposureStatus: text("ai_exposure_status").$type<"none" | "potential" | "observed">().notNull().default("none"),
  contentFingerprint: text("content_fingerprint"),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  discoveredVia: text("discovered_via").$type<"connector" | "api" | "manual">().notNull(),
  currentVersion: integer("current_version").notNull().default(1),
  lastScanId: uuid("last_scan_id").references(() => dataScans.id, { onDelete: "set null" }),
  lastClassifiedAt: ts("last_classified_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const dataAssetVersions = pgTable("data_asset_versions", {
  id: id(),
  organizationId: org(),
  assetId: uuid("asset_id").notNull().references(() => dataAssets.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
  changeNote: text("change_note").notNull().default(""),
  createdBy: userRef("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const dataClassifications = pgTable("data_classifications", {
  id: id(),
  organizationId: org(),
  assetId: uuid("asset_id").notNull().references(() => dataAssets.id, { onDelete: "cascade" }),
  category: text("category").notNull(),
  sensitivity: text("sensitivity").$type<SensitivityLevel>().notNull(),
  detectionMethod: text("detection_method").$type<"pattern" | "checksum" | "keyword" | "heuristic" | "custom" | "manual">().notNull(),
  detectors: text("detectors").array().notNull().default([]),
  confidence: text("confidence").$type<"low" | "medium" | "high">().notNull(),
  confidenceBasis: text("confidence_basis").notNull(),
  matchCount: integer("match_count").notNull().default(0),
  reviewStatus: text("review_status").$type<"unreviewed" | "confirmed" | "rejected">().notNull().default("unreviewed"),
  reviewedBy: userRef("reviewed_by"),
  reviewedAt: ts("reviewed_at"),
  scanId: uuid("scan_id").references(() => dataScans.id, { onDelete: "set null" }),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const accessFindings = pgTable("data_access_findings", {
  id: id(),
  organizationId: org(),
  assetId: uuid("asset_id").notNull().references(() => dataAssets.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  severity: text("severity").$type<SeverityLevel>().notNull(),
  principal: text("principal").notNull().default(""),
  detail: text("detail").notNull(),
  status: text("status").$type<"open" | "resolved" | "accepted">().notNull().default("open"),
  resolutionNote: text("resolution_note"),
  firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
  lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
  resolvedAt: ts("resolved_at"),
});

export const shadowAiTools = pgTable("shadow_ai_tools", {
  id: id(),
  organizationId: org(),
  catalogKey: text("catalog_key"),
  vendor: text("vendor").notNull(),
  name: text("name").notNull(),
  category: text("category").notNull().default("other"),
  domains: text("domains").array().notNull().default([]),
  status: text("status").$type<"approved" | "experimental" | "unknown" | "restricted" | "blocked">().notNull().default("unknown"),
  source: text("source").$type<"telemetry" | "manual" | "platform">().notNull(),
  userCount: integer("user_count").notNull().default(0),
  departments: text("departments").array().notNull().default([]),
  dataCategories: text("data_categories").array().notNull().default([]),
  riskScore: integer("risk_score").notNull().default(0),
  riskLevel: text("risk_level").$type<SeverityLevel>().notNull().default("low"),
  riskFactors: text("risk_factors").array().notNull().default([]),
  notes: text("notes").notNull().default(""),
  statusChangedBy: userRef("status_changed_by"),
  statusChangedAt: ts("status_changed_at"),
  firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
  lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const shadowAiUsage = pgTable("shadow_ai_usage", {
  id: id(),
  organizationId: org(),
  toolId: uuid("tool_id").notNull().references(() => shadowAiTools.id, { onDelete: "cascade" }),
  telemetrySource: text("telemetry_source").notNull(),
  userId: userRef("user_id"),
  userFingerprint: text("user_fingerprint"),
  department: text("department"),
  domain: text("domain"),
  eventCount: integer("event_count").notNull().default(1),
  bytesOut: bigint("bytes_out", { mode: "number" }),
  dataCategories: text("data_categories").array().notNull().default([]),
  externalRef: text("external_ref"),
  occurredAt: ts("occurred_at").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const exposureFindings = pgTable("ai_exposure_findings", {
  id: id(),
  organizationId: org(),
  assetId: uuid("asset_id").notNull().references(() => dataAssets.id, { onDelete: "cascade" }),
  exposureType: text("exposure_type").notNull(),
  toolId: uuid("tool_id").references(() => shadowAiTools.id, { onDelete: "set null" }),
  destination: text("destination").notNull().default(""),
  basis: text("basis").$type<"inferred" | "observed">().notNull(),
  severity: text("severity").$type<SeverityLevel>().notNull(),
  detail: text("detail").notNull(),
  status: text("status").$type<"open" | "resolved" | "accepted">().notNull().default("open"),
  firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
  lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
});

export const INCIDENT_KINDS = ["unauthorized_ai", "credential_exposure", "large_ai_export", "restricted_data_access", "abnormal_ai_activity", "policy_violation", "manual"] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

export const securityIncidents = pgTable("security_incidents", {
  id: id(),
  organizationId: org(),
  kind: text("kind").$type<IncidentKind>().notNull(),
  severity: text("severity").$type<SeverityLevel>().notNull(),
  status: text("status").$type<"open" | "investigating" | "contained" | "resolved">().notNull().default("open"),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  source: text("source").notNull(),
  ownerUserId: userRef("owner_user_id"),
  affectedAssetIds: uuid("affected_asset_ids").array().notNull().default([]),
  affectedUsers: text("affected_users").array().notNull().default([]),
  rootCause: text("root_cause"),
  resolution: text("resolution"),
  remediation: text("remediation"),
  dedupeKey: text("dedupe_key"),
  eventCount: integer("event_count").notNull().default(1),
  openedBy: userRef("opened_by"),
  resolvedBy: userRef("resolved_by"),
  resolvedAt: ts("resolved_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const incidentEvents = pgTable("incident_events", {
  id: id(),
  organizationId: org(),
  incidentId: uuid("incident_id").notNull().references(() => securityIncidents.id, { onDelete: "cascade" }),
  kind: text("kind").$type<"created" | "evidence" | "note" | "status_change" | "assignment" | "remediation" | "severity_change">().notNull(),
  message: text("message").notNull(),
  data: jsonb("data").$type<Record<string, unknown> | null>(),
  actorLabel: text("actor_label").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export interface DetectionSummary { category: string; count: number; confidence: string; methods: string[]; detectors: string[]; basis: string[] }

export const dlpEvents = pgTable("dlp_events", {
  id: id(),
  organizationId: org(),
  source: text("source").$type<"ai_gateway" | "api">().notNull(),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id").notNull(),
  actorLabel: text("actor_label").notNull(),
  userId: userRef("user_id"),
  destination: text("destination").notNull(),
  destinationTrust: text("destination_trust").notNull(),
  destinationCategory: text("destination_category").notNull(),
  toolId: uuid("tool_id").references(() => shadowAiTools.id, { onDelete: "set null" }),
  moduleId: text("module_id"),
  useCase: text("use_case"),
  decision: text("decision").$type<Decision>().notNull(),
  reasons: text("reasons").array().notNull().default([]),
  detections: jsonb("detections").$type<DetectionSummary[]>().notNull().default([]),
  categories: text("categories").array().notNull().default([]),
  policies: jsonb("policies").$type<Array<{ key: string; version: number; effect: string }>>().notNull().default([]),
  contentFingerprint: text("content_fingerprint").notNull(),
  contentChars: integer("content_chars").notNull(),
  redactedPreview: text("redacted_preview"),
  assetIds: uuid("asset_ids").array().notNull().default([]),
  approvalStatus: text("approval_status").$type<"pending" | "approved" | "rejected" | "expired" | "used" | null>(),
  approvalDecidedBy: userRef("approval_decided_by"),
  approvalDecidedAt: ts("approval_decided_at"),
  approvalNote: text("approval_note"),
  approvalExpiresAt: ts("approval_expires_at"),
  approvedVia: uuid("approved_via"),
  incidentId: uuid("incident_id").references(() => securityIncidents.id, { onDelete: "set null" }),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const redactionEvents = pgTable("redaction_events", {
  id: id(),
  organizationId: org(),
  dlpEventId: uuid("dlp_event_id").notNull().references(() => dlpEvents.id, { onDelete: "cascade" }),
  modes: text("modes").array().notNull().default([]),
  categories: text("categories").array().notNull().default([]),
  byLabel: jsonb("by_label").$type<Record<string, number>>().notNull().default({}),
  redactedCount: integer("redacted_count").notNull(),
  outputFingerprint: text("output_fingerprint").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const REMEDIATION_ACTIONS = ["remove_broad_sharing", "restrict_group", "change_classification", "assign_owner", "block_ai_destination", "require_approval", "rotate_credential"] as const;
export type RemediationAction = (typeof REMEDIATION_ACTIONS)[number];

export const remediationActions = pgTable("remediation_actions", {
  id: id(),
  organizationId: org(),
  action: text("action").$type<RemediationAction>().notNull(),
  execution: text("execution").$type<"automatic" | "manual">().notNull(),
  status: text("status").$type<"recommended" | "completed" | "dismissed" | "failed">().notNull().default("recommended"),
  assetId: uuid("asset_id").references(() => dataAssets.id, { onDelete: "cascade" }),
  toolId: uuid("tool_id").references(() => shadowAiTools.id, { onDelete: "cascade" }),
  incidentId: uuid("incident_id").references(() => securityIncidents.id, { onDelete: "set null" }),
  findingType: text("finding_type").$type<"access" | "exposure" | "incident" | "classification" | null>(),
  findingId: uuid("finding_id"),
  title: text("title").notNull(),
  detail: text("detail").notNull().default(""),
  params: jsonb("params").$type<Record<string, unknown>>().notNull().default({}),
  result: text("result"),
  dedupeKey: text("dedupe_key").notNull(),
  completedBy: userRef("completed_by"),
  completedAt: ts("completed_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});
