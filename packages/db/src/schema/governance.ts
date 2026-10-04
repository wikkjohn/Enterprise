import { index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, ts, updatedAt } from "./_columns";
import { organizations } from "./tenancy";
import { users } from "./identity";

export const policies = pgTable(
  "policies",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** Owner of the policy kind: "core" or the extending module id. */
    owner: text("owner").notNull().default("core"),
    /** The policy kind registered by the owner (e.g. "access", "ai_usage", "agent_action"). */
    kind: text("kind").notNull(),
    status: text("status", { enum: ["draft", "active", "disabled"] }).notNull().default("draft"),
    activeVersion: integer("active_version"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("policies_org_key_uq").on(t.organizationId, t.key)],
);

/** Immutable policy versions. A change creates a new version; history is never rewritten. */
export const policyVersions = pgTable(
  "policy_versions",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => policies.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
    changeNote: text("change_note"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("policy_versions_uq").on(t.policyId, t.version)],
);

/** Append-only audit log. UPDATE/DELETE are blocked by trigger and revoked from the app role. */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    /** NULL only for platform-level events (e.g. failed login for an unknown email). */
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "restrict" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date", precision: 3 }).notNull().defaultNow(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    actorLabel: text("actor_label").notNull(),
    module: text("module").notNull(),
    action: text("action").notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    outcome: text("outcome", { enum: ["success", "failure", "denied"] }).notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    ip: text("ip"),
    userAgent: text("user_agent"),
    correlationId: text("correlation_id"),
  },
  (t) => [
    index("audit_events_org_time_idx").on(t.organizationId, t.occurredAt),
    index("audit_events_org_action_idx").on(t.organizationId, t.action),
    index("audit_events_org_resource_idx").on(t.organizationId, t.resourceType, t.resourceId),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    recipientUserId: uuid("recipient_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    moduleId: text("module_id").notNull(),
    priority: text("priority", { enum: ["low", "normal", "high", "critical"] }).notNull().default("normal"),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    actionUrl: text("action_url"),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    readAt: ts("read_at"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_recipient_idx").on(t.organizationId, t.recipientUserId, t.createdAt)],
);

export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    channel: text("channel", { enum: ["in_app", "email", "webhook"] }).notNull(),
    enabled: text("enabled", { enum: ["on", "off"] }).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.userId, t.type, t.channel] })],
);

/** Recorded operational errors surfaced on the admin health page. Messages are redacted. */
export const platformErrors = pgTable(
  "platform_errors",
  {
    id: id(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
    severity: text("severity", { enum: ["warning", "error", "critical"] }).notNull(),
    source: text("source").notNull(),
    code: text("code"),
    message: text("message").notNull(),
    correlationId: text("correlation_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index("platform_errors_time_idx").on(t.occurredAt)],
);

/** Idempotency records for mutating API calls carrying an Idempotency-Key header. */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body"),
    createdAt: createdAt(),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.key] })],
);

/**
 * LOCAL DEVELOPMENT secret store backing table (AES-256-GCM ciphertext only).
 * Production deployments should use an external secret manager adapter.
 */
export const devSecretValues = pgTable(
  "dev_secret_values",
  {
    ref: text("ref").primaryKey(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    createdAt: createdAt(),
    destroyedAt: ts("destroyed_at"),
  },
  (t) => [index("dev_secret_values_org_idx").on(t.organizationId)],
);
