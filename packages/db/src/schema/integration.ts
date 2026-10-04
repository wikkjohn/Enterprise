import { unique, bigint, index, integer, jsonb, numeric, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createdAt, id, ts, updatedAt } from "./_columns";
import { organizations } from "./tenancy";
import { users } from "./identity";

/** A configured connection from a tenant to an external system. Non-secret config only. */
export const connectors = pgTable(
  "connectors",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // connector definition key, e.g. "rest_api", "salesforce"
    name: text("name").notNull(),
    description: text("description"),
    status: text("status", { enum: ["draft", "connected", "degraded", "failed", "disabled"] }).notNull().default("draft"),
    authType: text("auth_type", { enum: ["oauth2", "api_key", "service_account", "basic", "none"] }).notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    healthStatus: text("health_status", { enum: ["healthy", "degraded", "unhealthy", "unknown"] }).notNull().default("unknown"),
    lastHealthCheckAt: ts("last_health_check_at"),
    lastError: text("last_error"),
    /** Tenant-configured rate limit overriding the definition default. */
    rateLimit: jsonb("rate_limit").$type<{ requestsPerMinute?: number; burst?: number }>(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("connectors_org_idx").on(t.organizationId), uniqueIndex("connectors_org_name_uq").on(t.organizationId, t.name)],
);

/** Capabilities enabled for a connector instance (subset of its definition's declared capabilities). */
export const connectorCapabilities = pgTable(
  "connector_capabilities",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connectorId: uuid("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
    operations: text("operations").array().notNull(),
    enabled: text("enabled", { enum: ["enabled", "disabled"] }).notNull().default("enabled"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("connector_capabilities_uq").on(t.connectorId, t.capability)],
);

/** Credential METADATA. The secret value lives in the secret store, referenced by secret_ref. */
export const connectorCredentialsMetadata = pgTable(
  "connector_credentials_metadata",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connectorId: uuid("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["oauth2", "api_key", "service_account", "basic"] }).notNull(),
    secretRef: text("secret_ref").notNull(),
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    status: text("status", { enum: ["active", "revoked", "expired"] }).notNull().default("active"),
    expiresAt: ts("expires_at"),
    lastRotatedAt: ts("last_rotated_at"),
    rotationIntervalDays: integer("rotation_interval_days"),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Non-secret hint for UIs, e.g. last 4 characters. */
    hint: text("hint"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("connector_creds_connector_idx").on(t.connectorId)],
);

/** AI providers. organization_id NULL = platform-provided; non-null = tenant-provided (BYO key/deployment). */
export const aiProviders = pgTable(
  "ai_providers",
  {
    id: id(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["anthropic", "openai", "openai_compatible", "azure_openai", "google", "bedrock", "local", "sandbox"] }).notNull(),
    status: text("status", { enum: ["enabled", "disabled", "not_configured"] }).notNull().default("not_configured"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    credentialSecretRef: text("credential_secret_ref"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("ai_providers_org_key_uq").on(t.organizationId, t.key).nullsNotDistinct()],
);

export const aiModels = pgTable(
  "ai_models",
  {
    id: id(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => aiProviders.id, { onDelete: "cascade" }),
    modelKey: text("model_key").notNull(),
    displayName: text("display_name").notNull(),
    capabilities: text("capabilities").array().notNull().default(sql`'{}'::text[]`),
    contextWindow: integer("context_window"),
    maxOutputTokens: integer("max_output_tokens"),
    /** USD per 1M tokens. Estimates — confirm against your contract. */
    inputCostPerMtok: numeric("input_cost_per_mtok", { precision: 12, scale: 4 }).notNull().default("0"),
    outputCostPerMtok: numeric("output_cost_per_mtok", { precision: 12, scale: 4 }).notNull().default("0"),
    /** Tier used by routing: economy < standard < premium. */
    tier: text("tier", { enum: ["economy", "standard", "premium"] }).notNull().default("standard"),
    /** Highest data classification this model is approved to process. */
    maxDataClassification: text("max_data_classification", { enum: ["public", "internal", "confidential", "restricted"] }).notNull().default("internal"),
    status: text("status", { enum: ["active", "disabled", "deprecated"] }).notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("ai_models_provider_model_uq").on(t.providerId, t.modelKey)],
);

export const aiRuns = pgTable(
  "ai_runs",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    providerKey: text("provider_key").notNull(),
    modelKey: text("model_key").notNull(),
    moduleId: text("module_id").notNull(),
    useCase: text("use_case").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    status: text("status", { enum: ["succeeded", "failed", "blocked", "pending_approval"] }).notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 14, scale: 6 }).notNull().default("0"),
    promptRetention: text("prompt_retention", { enum: ["none", "metadata", "full"] }).notNull(),
    promptTemplateId: text("prompt_template_id"),
    promptTemplateVersion: text("prompt_template_version"),
    promptHash: text("prompt_hash"),
    promptChars: integer("prompt_chars"),
    responseChars: integer("response_chars"),
    /** Only populated when retention = full. */
    request: jsonb("request"),
    response: jsonb("response"),
    policyDecision: text("policy_decision"),
    policyReasons: jsonb("policy_reasons").$type<string[]>(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    correlationId: text("correlation_id"),
    /** Free-form references, e.g. { workflowId, sourceDocumentIds }. */
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("ai_runs_org_created_idx").on(t.organizationId, t.createdAt), index("ai_runs_org_module_idx").on(t.organizationId, t.moduleId)],
);

export const apiKeysMetadata = pgTable(
  "api_keys_metadata",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Public, non-secret identifier embedded in the key (eaop_<prefix>_<secret>). */
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    scopes: text("scopes").array().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    lastUsedAt: ts("last_used_at"),
    expiresAt: ts("expires_at"),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("api_keys_prefix_uq").on(t.prefix), index("api_keys_org_idx").on(t.organizationId)],
);

export const webhooks = pgTable(
  "webhooks",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    description: text("description"),
    eventTypes: text("event_types").array().notNull(),
    signingSecretRef: text("signing_secret_ref").notNull(),
    status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastDeliveryAt: ts("last_delivery_at"),
    lastDeliveryStatus: integer("last_delivery_status"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("webhooks_org_idx").on(t.organizationId)],
);

export const usageEvents = pgTable(
  "usage_events",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
    moduleId: text("module_id").notNull(),
    metric: text("metric").notNull(),
    quantity: numeric("quantity", { precision: 20, scale: 6 }).notNull(),
    unit: text("unit").notNull(),
    userId: uuid("user_id"),
    connectorId: uuid("connector_id"),
    agentId: text("agent_id"),
    aiProvider: text("ai_provider"),
    aiModel: text("ai_model"),
    workflowId: text("workflow_id"),
    endpoint: text("endpoint"),
    dimensions: jsonb("dimensions").$type<Record<string, string>>().notNull().default({}),
    /** Deduplication key so retried producers do not double-count. */
    dedupeKey: text("dedupe_key"),
  },
  (t) => [
    index("usage_events_org_time_idx").on(t.organizationId, t.occurredAt),
    index("usage_events_org_metric_idx").on(t.organizationId, t.metric, t.occurredAt),
    uniqueIndex("usage_events_dedupe_uq").on(t.organizationId, t.dedupeKey),
  ],
);

/** Durable, transactional outbox for the shared event bus. */
export const eventOutbox = pgTable(
  "event_outbox",
  {
    id: id(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    version: integer("version").notNull().default(1),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    actorType: text("actor_type"),
    actorId: text("actor_id"),
    correlationId: text("correlation_id"),
    status: text("status", { enum: ["pending", "dispatching", "dispatched", "failed", "dead"] }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
    availableAt: ts("available_at").notNull().defaultNow(),
    dispatchedAt: ts("dispatched_at"),
  },
  (t) => [index("event_outbox_status_idx").on(t.status, t.availableAt), index("event_outbox_org_idx").on(t.organizationId, t.occurredAt)],
);

export const backgroundJobsMetadata = pgTable(
  "background_jobs_metadata",
  {
    id: id(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    queue: text("queue").notNull().default("default"),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status", { enum: ["queued", "running", "succeeded", "failed", "dead", "cancelled"] }).notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    runAt: ts("run_at").notNull().defaultNow(),
    lockedAt: ts("locked_at"),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    idempotencyKey: text("idempotency_key"),
    correlationId: text("correlation_id"),
    durationMs: bigint("duration_ms", { mode: "number" }),
    createdAt: createdAt(),
    completedAt: ts("completed_at"),
  },
  (t) => [
    index("jobs_claim_idx").on(t.queue, t.status, t.runAt),
    uniqueIndex("jobs_idempotency_uq").on(t.type, t.idempotencyKey),
    index("jobs_org_idx").on(t.organizationId, t.createdAt),
  ],
);
