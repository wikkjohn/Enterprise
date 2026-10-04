import { z } from "zod";
import {
  and, connectorCapabilities, connectorCredentialsMetadata, connectors, desc, eq, inArray, isNotNull, lt, scopeOf, type Database,
} from "@eaop/db";
import { AuditActions, type AuditService } from "@eaop/audit";
import { type EventBus } from "@eaop/events";
import { type JobQueue } from "@eaop/jobs";
import { type NotificationService } from "@eaop/notifications";
import { redactString, type Logger, type Metrics } from "@eaop/observability";
import { type Authorizer } from "@eaop/rbac";
import { secretHint, type SecretStore } from "@eaop/secrets";
import { assertSafeOutboundUrl, randomToken, hmacSha256, constantTimeEqual, type RateLimiter, type UrlGuardOptions } from "@eaop/security";
import { AppError, conflict, notFound, SYSTEM_ACTOR, type TenantContext, type Uuid } from "@eaop/shared-types";
import { USAGE_METRICS, type UsageService } from "@eaop/usage";
import { type ConnectorCatalog } from "./catalog";
import { createGuardedFetch } from "./http";
import { ConnectorError, type AdapterContext, type CapabilityOperation, type ConnectorAdapter, type ConnectorAuthType, type ConnectorDefinition } from "./types";

export const createConnectorSchema = z.object({
  type: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  authType: z.enum(["oauth2", "api_key", "service_account", "basic", "none"]),
  config: z.record(z.unknown()).default({}),
  capabilities: z.array(z.string()).optional(),
});
export const updateConnectorSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(1000).nullable().optional(),
  config: z.record(z.unknown()).optional(),
  status: z.enum(["disabled", "draft"]).optional(),
  capabilities: z.array(z.string()).optional(),
  rateLimit: z.object({ requestsPerMinute: z.number().int().min(1).max(100_000) }).nullable().optional(),
});
export const setCredentialsSchema = z.object({
  values: z.record(z.string().max(20_000)).refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 20, "1–20 credential fields"),
  scopes: z.array(z.string().max(200)).max(100).optional(),
  expiresAt: z.coerce.date().optional(),
  rotationIntervalDays: z.number().int().min(1).max(3650).optional(),
});
export const executeSchema = z.object({
  capability: z.string().min(1).max(120),
  operation: z.enum(["read", "list", "search", "write", "delete", "execute", "subscribe"]),
  params: z.record(z.unknown()).default({}),
});

export interface ConnectorView {
  id: string;
  type: string;
  name: string;
  description: string | null;
  status: string;
  authType: string;
  config: Record<string, unknown>;
  scopes: string[];
  healthStatus: string;
  lastHealthCheckAt: string | null;
  lastError: string | null;
  availability: string;
  capabilities: Array<{ key: string; operations: string[]; enabled: boolean }>;
  credential: { id: string; kind: string; status: string; hint: string | null; expiresAt: string | null; lastRotatedAt: string | null; rotationIntervalDays: number | null } | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorService {
  catalog(): Array<Omit<ConnectorDefinition, "configSchema">>;
  list(ctx: TenantContext): Promise<ConnectorView[]>;
  get(ctx: TenantContext, id: Uuid): Promise<ConnectorView>;
  create(ctx: TenantContext, input: z.input<typeof createConnectorSchema>): Promise<ConnectorView>;
  update(ctx: TenantContext, id: Uuid, patch: z.input<typeof updateConnectorSchema>): Promise<ConnectorView>;
  remove(ctx: TenantContext, id: Uuid): Promise<void>;
  setCredentials(ctx: TenantContext, id: Uuid, input: z.input<typeof setCredentialsSchema>): Promise<ConnectorView>;
  rotateCredentials(ctx: TenantContext, id: Uuid, values: Record<string, string>): Promise<ConnectorView>;
  revokeCredentials(ctx: TenantContext, id: Uuid): Promise<ConnectorView>;
  test(ctx: TenantContext, id: Uuid): Promise<{ ok: boolean; message: string; latencyMs?: number }>;
  /** The ONLY path by which platform code calls an external system through a connector. */
  execute(ctx: TenantContext, id: Uuid, request: z.input<typeof executeSchema>, opts?: { moduleId?: string }): Promise<unknown>;
  /** Connectors (with this capability) a module can consume — used for discovery UIs. */
  findByCapability(ctx: TenantContext, capability: string): Promise<ConnectorView[]>;
  startOAuth(ctx: TenantContext, id: Uuid): Promise<{ authorizationUrl: string }>;
  completeOAuth(ctx: TenantContext, params: { code: string; state: string }): Promise<ConnectorView>;
  /** Worker sweep: health checks + expiring credential alerts across all tenants. */
  runHealthSweep(): Promise<{ checked: number; expiring: number }>;
}

const MAX_ATTEMPTS = 3;
const EXECUTE_TIMEOUT_MS = 30_000;

export function createConnectorService(deps: {
  db: Database;
  catalog: ConnectorCatalog;
  adapters: ConnectorAdapter[];
  secrets: SecretStore;
  authorizer: Authorizer;
  audit: AuditService;
  bus: EventBus;
  usage: UsageService;
  notifications: NotificationService;
  jobs: JobQueue;
  rateLimiter: RateLimiter;
  logger: Logger;
  metrics: Metrics;
  urlGuard: UrlGuardOptions;
  appUrl: string;
  appSecret: string;
  fetchImpl?: typeof fetch;
}): ConnectorService {
  const { db, catalog, secrets, authorizer, audit, bus, usage, logger, metrics } = deps;
  const adapters = new Map(deps.adapters.map((a) => [a.type, a]));

  type Row = typeof connectors.$inferSelect;

  async function loadRow(ctx: TenantContext, id: Uuid) {
    const [row] = await db.withTenant(scopeOf(ctx), (tx) => tx.select().from(connectors).where(and(eq(connectors.id, id), eq(connectors.organizationId, ctx.organizationId))).limit(1));
    if (!row) throw notFound("Connector", id);
    return row;
  }

  async function activeCredential(ctx: TenantContext, connectorId: Uuid) {
    const [c] = await db.withTenant(scopeOf(ctx), (tx) =>
      tx
        .select()
        .from(connectorCredentialsMetadata)
        .where(and(eq(connectorCredentialsMetadata.connectorId, connectorId), eq(connectorCredentialsMetadata.status, "active")))
        .orderBy(desc(connectorCredentialsMetadata.createdAt))
        .limit(1),
    );
    return c;
  }

  async function toView(ctx: TenantContext, row: Row): Promise<ConnectorView> {
    const def = catalog.get(row.type);
    const [caps, cred] = await Promise.all([
      db.withTenant(scopeOf(ctx), (tx) => tx.select().from(connectorCapabilities).where(eq(connectorCapabilities.connectorId, row.id))),
      activeCredential(ctx, row.id),
    ]);
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      description: row.description,
      status: row.status,
      authType: row.authType,
      config: row.config,
      scopes: row.scopes,
      healthStatus: row.healthStatus,
      lastHealthCheckAt: row.lastHealthCheckAt?.toISOString() ?? null,
      lastError: row.lastError,
      availability: def?.availability ?? "contract_only",
      capabilities: caps.map((c) => ({ key: c.capability, operations: c.operations, enabled: c.enabled === "enabled" })),
      credential: cred
        ? { id: cred.id, kind: cred.kind, status: cred.status, hint: cred.hint, expiresAt: cred.expiresAt?.toISOString() ?? null, lastRotatedAt: cred.lastRotatedAt?.toISOString() ?? null, rotationIntervalDays: cred.rotationIntervalDays }
        : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  function definition(type: string) {
    const def = catalog.get(type);
    if (!def) throw new AppError("VALIDATION_FAILED", `Unknown connector type "${type}".`);
    return def;
  }

  async function validateConfig(def: ConnectorDefinition, config: Record<string, unknown>) {
    // Defence in depth: never persist secrets in config — and never silently drop them either.
    for (const k of Object.keys(config)) if (/secret|password|token|api[-_]?key|private[-_]?key/i.test(k) && !/header|prefix|url/i.test(k)) throw new AppError("VALIDATION_FAILED", `"${k}" looks like a secret. Use credentials instead of config.`);
    const known = new Set(def.configFields.map((f) => f.key));
    const unknown = Object.keys(config).filter((k) => !known.has(k));
    if (def.availability !== "contract_only" && unknown.length) throw new AppError("VALIDATION_FAILED", `Unknown configuration keys: ${unknown.join(", ")}`);
    const parsed = def.configSchema.safeParse(config);
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", "Invalid connector configuration.", { issues: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })) });
    const cfg = parsed.data as Record<string, unknown>;
    for (const k of def.urlConfigKeys ?? []) if (typeof cfg[k] === "string") await assertSafeOutboundUrl(cfg[k] as string, deps.urlGuard);
    return cfg;
  }

  async function readCredentialValues(ctx: TenantContext, connectorId: Uuid) {
    const cred = await activeCredential(ctx, connectorId);
    if (!cred) return { cred: undefined, values: null };
    if (cred.expiresAt && cred.expiresAt < new Date() && cred.kind !== "oauth2") throw new ConnectorError("auth", "Connector credential has expired.");
    const raw = await secrets.get(cred.secretRef, ctx.organizationId);
    return { cred, values: JSON.parse(raw) as Record<string, string> };
  }

  async function adapterContext(ctx: TenantContext, row: Row, values: Record<string, string> | null, signal: AbortSignal): Promise<AdapterContext> {
    return {
      connectorId: row.id,
      organizationId: ctx.organizationId,
      config: row.config,
      authType: row.authType as ConnectorAuthType,
      credentials: values,
      fetch: createGuardedFetch(deps.urlGuard, signal, deps.fetchImpl),
      signal,
    };
  }

  async function storeRefreshed(ctx: TenantContext, credId: Uuid, secretRef: string, values: Record<string, string>, expiresAt?: Date) {
    const ref = await secrets.rotate(secretRef, ctx.organizationId, JSON.stringify(values));
    await db.withTenant(scopeOf(ctx), (tx) =>
      tx.update(connectorCredentialsMetadata).set({ secretRef: ref, expiresAt: expiresAt ?? null, lastRotatedAt: new Date(), updatedAt: new Date() }).where(eq(connectorCredentialsMetadata.id, credId)),
    );
  }

  async function setHealth(ctx: TenantContext, row: Row, health: "healthy" | "unhealthy" | "degraded", error: string | null) {
    const status = health === "healthy" ? "connected" : health === "degraded" ? "degraded" : "failed";
    await db.withTenant(scopeOf(ctx), (tx) =>
      tx
        .update(connectors)
        .set({ healthStatus: health, status: row.status === "disabled" ? "disabled" : status, lastHealthCheckAt: new Date(), lastError: error ? redactString(error).slice(0, 1000) : null, updatedAt: new Date() })
        .where(eq(connectors.id, row.id)),
    );
    if (row.healthStatus !== health) await bus.publish(ctx, "connector.health_changed", { connectorId: row.id, from: row.healthStatus, to: health });
    if (health === "unhealthy" && row.healthStatus !== "unhealthy") {
      await bus.publish(ctx, "connector.failed", { connectorId: row.id, errorClass: "health_check", message: redactString(error ?? "failed").slice(0, 300) });
      await deps.notifications.notify({ ...ctx, actor: SYSTEM_ACTOR("connectors") }, {
        type: "core.connector_failed",
        title: `Connector "${row.name}" is failing`,
        body: redactString(error ?? "Health check failed.").slice(0, 500),
        actionUrl: `/admin/connectors/${row.id}`,
        resource: { type: "connector", id: row.id },
        recipients: { permission: "connector.manage" },
      });
    }
  }

  const stripSchema = ({ configSchema: _c, ...rest }: ConnectorDefinition) => rest;

  const service: ConnectorService = {
    catalog: () => catalog.list().map(stripSchema),

    async list(ctx) {
      await authorizer.require(ctx, "connector.read");
      const rows = await db.withTenant(scopeOf(ctx), (tx) => tx.select().from(connectors).where(eq(connectors.organizationId, ctx.organizationId)).orderBy(connectors.name));
      return Promise.all(rows.map((r) => toView(ctx, r)));
    },

    async get(ctx, id) {
      await authorizer.require(ctx, "connector.read", { type: "connector", id });
      return toView(ctx, await loadRow(ctx, id));
    },

    async create(ctx, raw) {
      await authorizer.require(ctx, "connector.manage");
      const input = createConnectorSchema.parse(raw);
      const def = definition(input.type);
      if (!def.authTypes.includes(input.authType)) throw new AppError("VALIDATION_FAILED", `${def.name} does not support ${input.authType} authentication.`);
      const config = await validateConfig(def, input.config);
      const capKeys = input.capabilities ?? def.capabilities.map((c) => c.key);
      for (const k of capKeys) if (!def.capabilities.some((c) => c.key === k)) throw new AppError("VALIDATION_FAILED", `Unknown capability "${k}".`);
      return db.withTenant(scopeOf(ctx), async (tx) => {
        const dup = await tx.select({ id: connectors.id }).from(connectors).where(and(eq(connectors.organizationId, ctx.organizationId), eq(connectors.name, input.name))).limit(1);
        if (dup[0]) throw conflict("A connector with that name already exists.");
        const [row] = await tx
          .insert(connectors)
          .values({ organizationId: ctx.organizationId, type: def.type, name: input.name, description: input.description ?? null, authType: input.authType, config, createdBy: ctx.actor.type === "user" ? ctx.actor.id : null })
          .returning();
        await tx.insert(connectorCapabilities).values(
          def.capabilities.map((c) => ({ organizationId: ctx.organizationId, connectorId: row!.id, capability: c.key, operations: c.operations, enabled: capKeys.includes(c.key) ? ("enabled" as const) : ("disabled" as const) })),
        );
        await audit.record(ctx, { action: AuditActions.CONNECTOR_CREATED, resourceType: "connector", resourceId: row!.id, after: { type: def.type, name: input.name, authType: input.authType, config, capabilities: capKeys } });
        await bus.publish(ctx, "connector.created", { connectorId: row!.id, type: def.type, name: input.name });
        return toView(ctx, row!);
      });
    },

    async update(ctx, id, raw) {
      await authorizer.require(ctx, "connector.manage", { type: "connector", id });
      const patch = updateConnectorSchema.parse(raw);
      const row = await loadRow(ctx, id);
      const def = definition(row.type);
      const config = patch.config ? await validateConfig(def, patch.config) : undefined;
      return db.withTenant(scopeOf(ctx), async (tx) => {
        const [u] = await tx
          .update(connectors)
          .set({
            ...(patch.name ? { name: patch.name } : {}),
            ...(patch.description !== undefined ? { description: patch.description } : {}),
            ...(config ? { config } : {}),
            ...(patch.status ? { status: patch.status } : {}),
            ...(patch.rateLimit !== undefined ? { rateLimit: patch.rateLimit } : {}),
            updatedAt: new Date(),
          })
          .where(eq(connectors.id, id))
          .returning();
        if (patch.capabilities) {
          for (const c of def.capabilities) {
            await tx
              .update(connectorCapabilities)
              .set({ enabled: patch.capabilities.includes(c.key) ? "enabled" : "disabled" })
              .where(and(eq(connectorCapabilities.connectorId, id), eq(connectorCapabilities.capability, c.key)));
          }
        }
        const fields = Object.keys(patch);
        await audit.record(ctx, { action: AuditActions.CONNECTOR_UPDATED, resourceType: "connector", resourceId: id, before: { name: row.name, config: row.config, status: row.status }, after: patch });
        await bus.publish(ctx, "connector.updated", { connectorId: id, fields });
        return toView(ctx, u!);
      });
    },

    async remove(ctx, id) {
      await authorizer.require(ctx, "connector.manage", { type: "connector", id });
      const row = await loadRow(ctx, id);
      const creds = await db.withTenant(scopeOf(ctx), (tx) => tx.select().from(connectorCredentialsMetadata).where(eq(connectorCredentialsMetadata.connectorId, id)));
      for (const c of creds) await secrets.destroy(c.secretRef, ctx.organizationId).catch(() => undefined);
      await db.withTenant(scopeOf(ctx), async (tx) => {
        await tx.delete(connectors).where(eq(connectors.id, id));
        await audit.record(ctx, { action: AuditActions.CONNECTOR_DELETED, resourceType: "connector", resourceId: id, before: { name: row.name, type: row.type } });
        await bus.publish(ctx, "connector.deleted", { connectorId: id });
      });
    },

    async setCredentials(ctx, id, raw) {
      await authorizer.require(ctx, "connector.credential.manage", { type: "connector", id });
      const input = setCredentialsSchema.parse(raw);
      const row = await loadRow(ctx, id);
      const def = definition(row.type);
      const fields = def.credentialFields[row.authType as ConnectorAuthType] ?? [];
      for (const f of fields) if (f.required && !input.values[f.key]) throw new AppError("VALIDATION_FAILED", `Missing credential field "${f.label}".`);
      const unknown = Object.keys(input.values).filter((k) => !fields.some((f) => f.key === k));
      if (unknown.length) throw new AppError("VALIDATION_FAILED", `Unexpected credential fields: ${unknown.join(", ")}`);
      const previous = await activeCredential(ctx, id);
      const ref = await secrets.put({ organizationId: ctx.organizationId, name: `connector:${id}`, value: JSON.stringify(input.values) });
      const primary = fields.find((f) => f.secret);
      await db.withTenant(scopeOf(ctx), async (tx) => {
        if (previous) await tx.update(connectorCredentialsMetadata).set({ status: "revoked", updatedAt: new Date() }).where(eq(connectorCredentialsMetadata.id, previous.id));
        await tx.insert(connectorCredentialsMetadata).values({
          organizationId: ctx.organizationId,
          connectorId: id,
          kind: (row.authType === "none" ? "api_key" : row.authType) as "api_key",
          secretRef: ref,
          scopes: input.scopes ?? [],
          expiresAt: input.expiresAt ?? null,
          lastRotatedAt: new Date(),
          rotationIntervalDays: input.rotationIntervalDays ?? null,
          ownerUserId: ctx.actor.type === "user" ? ctx.actor.id : null,
          hint: primary && input.values[primary.key] ? secretHint(input.values[primary.key]!) : null,
        });
        await tx.update(connectors).set({ scopes: input.scopes ?? row.scopes, updatedAt: new Date() }).where(eq(connectors.id, id));
        await audit.record(ctx, { action: AuditActions.CREDENTIAL_SET, resourceType: "connector", resourceId: id, after: { fields: Object.keys(input.values), scopes: input.scopes, expiresAt: input.expiresAt } });
      });
      if (previous) await secrets.destroy(previous.secretRef, ctx.organizationId).catch(() => undefined);
      return toView(ctx, await loadRow(ctx, id));
    },

    async rotateCredentials(ctx, id, values) {
      await authorizer.require(ctx, "connector.credential.manage", { type: "connector", id });
      const cred = await activeCredential(ctx, id);
      if (!cred) throw new AppError("CONFLICT", "No active credential to rotate.");
      const current = JSON.parse(await secrets.get(cred.secretRef, ctx.organizationId)) as Record<string, string>;
      const next = { ...current, ...z.record(z.string().max(20_000)).parse(values) };
      const ref = await secrets.rotate(cred.secretRef, ctx.organizationId, JSON.stringify(next));
      await db.withTenant(scopeOf(ctx), async (tx) => {
        await tx.update(connectorCredentialsMetadata).set({ secretRef: ref, lastRotatedAt: new Date(), updatedAt: new Date() }).where(eq(connectorCredentialsMetadata.id, cred.id));
        await audit.record(ctx, { action: AuditActions.CREDENTIAL_ROTATED, resourceType: "connector", resourceId: id, metadata: { credentialId: cred.id, fields: Object.keys(values) } });
        await bus.publish(ctx, "credential.rotated", { connectorId: id, credentialId: cred.id });
      });
      return toView(ctx, await loadRow(ctx, id));
    },

    async revokeCredentials(ctx, id) {
      await authorizer.require(ctx, "connector.credential.manage", { type: "connector", id });
      const cred = await activeCredential(ctx, id);
      if (!cred) throw new AppError("CONFLICT", "No active credential.");
      await secrets.destroy(cred.secretRef, ctx.organizationId);
      await db.withTenant(scopeOf(ctx), async (tx) => {
        await tx.update(connectorCredentialsMetadata).set({ status: "revoked", updatedAt: new Date() }).where(eq(connectorCredentialsMetadata.id, cred.id));
        await tx.update(connectors).set({ status: "draft", healthStatus: "unknown", updatedAt: new Date() }).where(eq(connectors.id, id));
        await audit.record(ctx, { action: AuditActions.CREDENTIAL_REVOKED, resourceType: "connector", resourceId: id, metadata: { credentialId: cred.id } });
      });
      return toView(ctx, await loadRow(ctx, id));
    },

    async test(ctx, id) {
      await authorizer.require(ctx, "connector.manage", { type: "connector", id });
      const row = await loadRow(ctx, id);
      const def = definition(row.type);
      const adapter = adapters.get(row.type);
      if (!adapter || def.availability === "contract_only") {
        throw new AppError("NOT_IMPLEMENTED", `The ${def.name} adapter is not available yet. Its configuration is saved and will be used once the adapter ships.`);
      }
      const signal = AbortSignal.timeout(15_000);
      let result: { ok: boolean; message: string; latencyMs?: number };
      try {
        const { values } = await readCredentialValues(ctx, id);
        let actx = await adapterContext(ctx, row, values, signal);
        if (row.authType === "oauth2" && adapter.refreshCredentials && !values?.accessToken && values) {
          const refreshed = await adapter.refreshCredentials(actx);
          const cred = await activeCredential(ctx, id);
          await storeRefreshed(ctx, cred!.id, cred!.secretRef, refreshed.values, refreshed.expiresAt);
          actx = await adapterContext(ctx, row, refreshed.values, signal);
        }
        result = await adapter.testConnection(actx);
      } catch (err) {
        result = { ok: false, message: err instanceof Error ? redactString(err.message) : "Connection test failed." };
      }
      await setHealth(ctx, row, result.ok ? "healthy" : "unhealthy", result.ok ? null : result.message);
      await audit.record(ctx, { action: AuditActions.CONNECTOR_TESTED, resourceType: "connector", resourceId: id, outcome: result.ok ? "success" : "failure", metadata: { message: result.message } });
      return result;
    },

    async execute(ctx, id, raw, opts = {}) {
      await authorizer.require(ctx, "connector.use", { type: "connector", id });
      const req = executeSchema.parse(raw);
      const row = await loadRow(ctx, id);
      if (row.status === "disabled") throw new AppError("CONFLICT", "Connector is disabled.");
      const def = definition(row.type);
      const adapter = adapters.get(row.type);
      if (!adapter || def.availability === "contract_only") throw new AppError("NOT_IMPLEMENTED", `The ${def.name} adapter is not available yet.`);
      const [capRow] = await db.withTenant(scopeOf(ctx), (tx) =>
        tx.select().from(connectorCapabilities).where(and(eq(connectorCapabilities.connectorId, id), eq(connectorCapabilities.capability, req.capability))).limit(1),
      );
      if (!capRow || capRow.enabled !== "enabled") throw new AppError("FORBIDDEN", `Capability "${req.capability}" is not enabled on this connector.`);
      if (!capRow.operations.includes(req.operation)) throw new AppError("FORBIDDEN", `Operation "${req.operation}" is not declared for "${req.capability}".`);

      const rpm = row.rateLimit?.requestsPerMinute ?? def.rateLimit.requestsPerMinute;
      const rl = await deps.rateLimiter.consume(`connector:${row.id}`, { limit: rpm, windowSeconds: 60 });
      if (!rl.allowed) throw new AppError("RATE_LIMITED", "Connector rate limit reached.", { retryAfterSeconds: rl.retryAfterSeconds });

      const started = performance.now();
      const signal = AbortSignal.timeout(EXECUTE_TIMEOUT_MS);
      let { cred, values } = await readCredentialValues(ctx, id);
      let refreshed = false;
      let lastErr: unknown;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const result = await adapter.execute(await adapterContext(ctx, row, values, signal), { capability: req.capability, operation: req.operation as CapabilityOperation, params: req.params });
          const ms = Math.round(performance.now() - started);
          metrics.increment("eaop_connector_actions_total", { type: row.type, outcome: "ok" });
          metrics.observe("eaop_connector_latency_ms", ms, { type: row.type });
          await usage.record(ctx, { moduleId: (opts.moduleId ?? "core") as "core", metric: USAGE_METRICS.CONNECTOR_ACTIONS.key, unit: USAGE_METRICS.CONNECTOR_ACTIONS.unit, quantity: 1, connectorId: id, userId: ctx.actor.type === "user" ? ctx.actor.id : null, dimensions: { capability: req.capability, operation: req.operation } });
          if (["write", "delete", "execute"].includes(req.operation)) {
            await audit.record(ctx, { module: (opts.moduleId ?? "core") as "core", action: "connector.action_executed", resourceType: "connector", resourceId: id, metadata: { capability: req.capability, operation: req.operation, attempts: attempt, latencyMs: ms } });
          }
          return result;
        } catch (err) {
          lastErr = err;
          const ce = err instanceof ConnectorError ? err : new ConnectorError("transient", err instanceof Error ? err.message : String(err));
          if (ce.errorClass === "auth" && !refreshed && adapter.refreshCredentials && cred && values) {
            refreshed = true;
            try {
              const r = await adapter.refreshCredentials(await adapterContext(ctx, row, values, signal));
              await storeRefreshed(ctx, cred.id, cred.secretRef, r.values, r.expiresAt);
              ({ cred, values } = await readCredentialValues(ctx, id));
              continue;
            } catch (refreshErr) {
              lastErr = refreshErr;
              break;
            }
          }
          if (!(ce.errorClass === "transient" || ce.errorClass === "rate_limited") || attempt === MAX_ATTEMPTS) break;
          const delay = Math.min(30, ce.retryAfterSeconds ?? 0.2 * 2 ** attempt) * 1000;
          await new Promise((r) => setTimeout(r, delay));
        }
      }
      const ce = lastErr instanceof ConnectorError ? lastErr : new ConnectorError("transient", lastErr instanceof Error ? lastErr.message : "Connector call failed.");
      metrics.increment("eaop_connector_actions_total", { type: row.type, outcome: ce.errorClass });
      logger.warn("connector.execute_failed", { connectorId: id, errorClass: ce.errorClass, message: ce.message });
      await db.withTenant(scopeOf(ctx), (tx) => tx.update(connectors).set({ lastError: redactString(ce.message).slice(0, 1000), updatedAt: new Date() }).where(eq(connectors.id, id)));
      await bus.publish(ctx, "connector.failed", { connectorId: id, errorClass: ce.errorClass, message: redactString(ce.message).slice(0, 300) });
      throw ce;
    },

    async findByCapability(ctx, capability) {
      await authorizer.require(ctx, "connector.read");
      const rows = await db.withTenant(scopeOf(ctx), (tx) =>
        tx
          .select({ c: connectors })
          .from(connectors)
          .innerJoin(connectorCapabilities, eq(connectorCapabilities.connectorId, connectors.id))
          .where(and(eq(connectors.organizationId, ctx.organizationId), eq(connectorCapabilities.capability, capability), eq(connectorCapabilities.enabled, "enabled"))),
      );
      return Promise.all(rows.map((r) => toView(ctx, r.c)));
    },

    async startOAuth(ctx, id) {
      await authorizer.require(ctx, "connector.credential.manage", { type: "connector", id });
      const row = await loadRow(ctx, id);
      const def = definition(row.type);
      if (!def.oauth || row.authType !== "oauth2") throw new AppError("VALIDATION_FAILED", "This connector does not use OAuth2 authorization-code sign-in.");
      const { values } = await readCredentialValues(ctx, id);
      if (!values?.clientId) throw new AppError("CONFLICT", "Set the OAuth client ID and secret first.");
      const nonce = randomToken(16);
      const payload = Buffer.from(JSON.stringify({ c: id, o: ctx.organizationId, n: nonce, e: Date.now() + 10 * 60_000 })).toString("base64url");
      const state = `${payload}.${hmacSha256(deps.appSecret, payload)}`;
      const fill = (u: string) => u.replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(String(row.config[k] ?? "")));
      const url = new URL(fill(def.oauth.authorizationUrl));
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", values.clientId);
      url.searchParams.set("redirect_uri", `${deps.appUrl.replace(/\/$/, "")}/api/v1/connectors/oauth/callback`);
      url.searchParams.set("scope", (row.scopes.length ? row.scopes : def.oauth.defaultScopes).join(" "));
      url.searchParams.set("state", state);
      return { authorizationUrl: url.toString() };
    },

    async completeOAuth(ctx, params) {
      const [payload, mac] = params.state.split(".");
      if (!payload || !mac || !constantTimeEqual(mac, hmacSha256(deps.appSecret, payload))) throw new AppError("UNAUTHENTICATED", "Invalid OAuth state.");
      const st = JSON.parse(Buffer.from(payload, "base64url").toString()) as { c: string; o: string; e: number };
      if (st.e < Date.now() || st.o !== ctx.organizationId) throw new AppError("UNAUTHENTICATED", "OAuth state expired or belongs to another organization.");
      await authorizer.require(ctx, "connector.credential.manage", { type: "connector", id: st.c });
      const row = await loadRow(ctx, st.c);
      const def = definition(row.type);
      const { cred, values } = await readCredentialValues(ctx, row.id);
      if (!def.oauth || !cred || !values?.clientId || !values.clientSecret) throw new AppError("CONFLICT", "OAuth client credentials are missing.");
      const tokenUrl = def.oauth.tokenUrl.replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(String(row.config[k] ?? "")));
      const f = createGuardedFetch(deps.urlGuard, AbortSignal.timeout(15_000), deps.fetchImpl);
      const res = await f(tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: params.code, client_id: values.clientId, client_secret: values.clientSecret, redirect_uri: `${deps.appUrl.replace(/\/$/, "")}/api/v1/connectors/oauth/callback` }).toString(),
      });
      if (res.status >= 400) throw new AppError("UPSTREAM_ERROR", "The provider rejected the authorization code.");
      const tok = res.json<{ access_token?: string; refresh_token?: string; expires_in?: number; scope?: string }>();
      if (!tok.access_token) throw new AppError("UPSTREAM_ERROR", "No access token returned.");
      await storeRefreshed(ctx, cred.id, cred.secretRef, { ...values, accessToken: tok.access_token, ...(tok.refresh_token ? { refreshToken: tok.refresh_token } : {}) }, tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : undefined);
      await audit.record(ctx, { action: AuditActions.CREDENTIAL_ROTATED, resourceType: "connector", resourceId: row.id, metadata: { via: "oauth_authorization_code", scope: tok.scope } });
      return toView(ctx, await loadRow(ctx, row.id));
    },

    async runHealthSweep() {
      const rows = await db.withSystem("connectors.health_sweep", (tx) =>
        tx.select().from(connectors).where(inArray(connectors.status, ["connected", "degraded", "failed"])).limit(500),
      );
      let checked = 0;
      for (const row of rows) {
        const def = catalog.get(row.type);
        if (!def || def.availability === "contract_only") continue;
        const ctx: TenantContext = { organizationId: row.organizationId, actor: SYSTEM_ACTOR("connectors.health"), correlationId: `health-${row.id}`, cache: new Map() };
        await service.test(ctx, row.id).catch((e: Error) => logger.warn("connector.health_check_error", { connectorId: row.id, error: e.message }));
        checked++;
      }
      const soon = new Date(Date.now() + 7 * 86_400_000);
      const expiring = await db.withSystem("connectors.expiring", (tx) =>
        tx
          .select()
          .from(connectorCredentialsMetadata)
          .where(and(eq(connectorCredentialsMetadata.status, "active"), isNotNull(connectorCredentialsMetadata.expiresAt), lt(connectorCredentialsMetadata.expiresAt, soon))),
      );
      for (const c of expiring) {
        if (c.kind === "oauth2") continue; // refreshed automatically
        const day = new Date().toISOString().slice(0, 10);
        await deps.jobs.enqueue("connectors.credential_expiring", { connectorId: c.connectorId, credentialId: c.id, expiresAt: c.expiresAt!.toISOString() }, { organizationId: c.organizationId, idempotencyKey: `${c.id}:${day}` });
      }
      return { checked, expiring: expiring.length };
    },
  };

  deps.jobs.register({
    type: "connectors.credential_expiring",
    async handle(job) {
      const p = job.payload as { connectorId: string; credentialId: string; expiresAt: string };
      const ctx: TenantContext = { organizationId: job.organizationId!, actor: SYSTEM_ACTOR("connectors"), correlationId: job.correlationId ?? job.id, cache: new Map() };
      await bus.publish(ctx, "credential.expiring", p);
      await deps.notifications.notify(ctx, {
        type: "core.credential_expiring",
        title: "A connector credential expires soon",
        body: `Credential for connector ${p.connectorId} expires at ${p.expiresAt}. Rotate it to avoid an outage.`,
        actionUrl: `/admin/connectors/${p.connectorId}`,
        recipients: { permission: "connector.credential.manage" },
      });
    },
  });
  deps.jobs.register({
    type: "connectors.health_sweep",
    async handle() {
      await service.runHealthSweep();
    },
  });

  return service;
}
