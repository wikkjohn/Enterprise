import { anthropicProvider, createAIService, createOpenAICompatibleProvider, sandboxProvider, type AIService } from "@eaop/ai";
import { createAuditService, type AuditService } from "@eaop/audit";
import { createApiKeyService, createAuthService, createSsoService, SessionManager, type ApiKeyService, type AuthService, type SsoService } from "@eaop/auth";
import {
  ConnectorCatalog, createConnectorService, defaultConnectorDefinitions, graphqlAdapter, outboundWebhookAdapter, restApiAdapter, sandboxAdapter,
  type ConnectorAdapter, type ConnectorService,
} from "@eaop/connectors";
import { and, connectors, createDatabase, eq, ilike, memberships, or, policies, users, type Database } from "@eaop/db";
import { CORE_EVENTS, createEventBus, createWebhookService, EventRegistry, type EventBus, type WebhookService } from "@eaop/events";
import { createJobQueue, type JobQueue } from "@eaop/jobs";
import { createModuleService, ModuleRegistry, type ModuleManifest, type ModuleService } from "@eaop/module-registry";
import { manifest as agentGovernance } from "@eaop/module-agent-governance";
import { manifest as aiOperations } from "@eaop/module-ai-operations";
import { manifest as dataSecurity } from "@eaop/module-data-security";
import { manifest as integrationHub } from "@eaop/module-integration-hub";
import { manifest as knowledgeVerification } from "@eaop/module-knowledge-verification";
import { manifest as workflowIntelligence } from "@eaop/module-workflow-intelligence";
import {
  CORE_NOTIFICATION_TYPES, createNotificationService, NotificationTypeRegistry, UnconfiguredEmailSender, WebhookEmailSender,
  type EmailSender, type NotificationService,
} from "@eaop/notifications";
import { createLogger, createMetrics, createTracer, type MemorySink, type Logger, type Metrics, type Tracer } from "@eaop/observability";
import { createOrganizationService, type OrganizationService } from "@eaop/organizations";
import { createPolicyService, PolicyEngine, type PolicyService } from "@eaop/policies";
import { CORE_PERMISSIONS, createAuthorizer, createRoleService, PermissionRegistry, type Authorizer, type RoleService } from "@eaop/rbac";
import { createSearchService, textScore, type SearchService } from "@eaop/search";
import { createSecretStore, type SecretStore } from "@eaop/secrets";
import { MemoryRateLimiter, type RateLimiter, type UrlGuardOptions } from "@eaop/security";
import { createUsageService, type UsageService } from "@eaop/usage";
import { isModuleId } from "@eaop/shared-types";
import { type PlatformEnv } from "./config";
import { createErrorReporter, type ErrorReporter } from "./errors";
import { createHealthService, type HealthService } from "./health";

/** The placeholder manifests for the six modular applications. */
export const MODULE_MANIFESTS: ModuleManifest[] = [workflowIntelligence, integrationHub, agentGovernance, dataSecurity, knowledgeVerification, aiOperations];

export interface Platform {
  env: PlatformEnv;
  db: Database;
  logger: Logger;
  metrics: Metrics;
  tracer: Tracer;
  errors: ErrorReporter;
  secrets: SecretStore;
  rateLimiter: RateLimiter;
  audit: AuditService;
  jobs: JobQueue;
  events: { registry: EventRegistry; bus: EventBus; webhooks: WebhookService };
  rbac: { registry: PermissionRegistry; authorizer: Authorizer; roles: RoleService };
  policies: PolicyService;
  policyEngine: PolicyEngine;
  notifications: NotificationService;
  notificationTypes: NotificationTypeRegistry;
  usage: UsageService;
  search: SearchService;
  modules: ModuleService;
  moduleRegistry: ModuleRegistry;
  organizations: OrganizationService;
  auth: AuthService;
  sessions: SessionManager;
  apiKeys: ApiKeyService;
  sso: SsoService;
  connectors: ConnectorService;
  connectorCatalog: ConnectorCatalog;
  ai: AIService;
  health: HealthService;
  /** Sync code registrations (permissions, roles, modules, AI catalog) to the DB. Idempotent. */
  bootstrap(): Promise<void>;
  close(): Promise<void>;
}

export interface PlatformOverrides {
  db?: Database;
  logger?: Logger;
  logSink?: MemorySink;
  fetchImpl?: typeof fetch;
  email?: EmailSender;
  rateLimiter?: RateLimiter;
  modules?: ModuleManifest[];
  extraConnectorAdapters?: ConnectorAdapter[];
  urlGuard?: UrlGuardOptions;
  resolveTxt?: (name: string) => Promise<string[][]>;
}

/**
 * Composition root. Builds every shared-core service ONCE and wires module
 * manifests into the shared registries. Modules receive this object (or a
 * subset) — they never construct their own infrastructure.
 */
export function createPlatform(env: PlatformEnv, o: PlatformOverrides = {}): Platform {
  const isProd = env.APP_ENV === "production";
  const logger = o.logger ?? createLogger({ level: env.LOG_LEVEL, ...(o.logSink ? { sink: o.logSink } : {}), bindings: { service: "eaop" } });
  const metrics = createMetrics();
  const tracer = createTracer({ logger, metrics });
  const db = o.db ?? createDatabase({ connectionString: env.DATABASE_URL, onAfterCommitError: (err) => logger.error("db.after_commit_failed", { error: (err as Error).message }) });
  const errors = createErrorReporter({ db, logger });
  const urlGuard: UrlGuardOptions = o.urlGuard ?? { allowHttp: !isProd && env.ALLOW_PRIVATE_NETWORK_EGRESS, allowPrivateNetworks: env.ALLOW_PRIVATE_NETWORK_EGRESS };
  const secrets = createSecretStore(db, env as unknown as Record<string, string | undefined>);
  const rateLimiter = o.rateLimiter ?? new MemoryRateLimiter();
  const audit = createAuditService({ db, logger });
  const jobs = createJobQueue({ db, logger, metrics });

  // ── Registries (populated by core + module manifests) ───────────────────
  const permissionRegistry = new PermissionRegistry();
  permissionRegistry.register("core", CORE_PERMISSIONS);
  const eventRegistry = new EventRegistry();
  CORE_EVENTS.forEach((c) => eventRegistry.register(c));
  const notificationTypes = new NotificationTypeRegistry();
  CORE_NOTIFICATION_TYPES.forEach((t) => notificationTypes.register(t));
  const moduleRegistry = new ModuleRegistry();
  const policyEngine = new PolicyEngine();
  const roleGrants: Record<string, string[]> = {};

  const bus = createEventBus({ db, registry: eventRegistry, jobs, logger, metrics });
  const webhooks = createWebhookService({ db, bus, registry: eventRegistry, jobs, secrets, logger, urlGuard, fetchImpl: o.fetchImpl, audit: (ctx, action, resourceId, after) => audit.record(ctx, { action, resourceType: "webhook", resourceId, after }) });
  const authorizer = createAuthorizer({ db, registry: permissionRegistry, audit });
  const roles = createRoleService({ db, registry: permissionRegistry, authorizer, audit, bus, extraRoleGrants: () => roleGrants });
  const policyService = createPolicyService({ db, engine: policyEngine, authorizer, audit, bus });
  const email = o.email ?? (env.EMAIL_WEBHOOK_URL ? new WebhookEmailSender(env.EMAIL_WEBHOOK_URL, o.fetchImpl) : new UnconfiguredEmailSender(logger));
  const notifications = createNotificationService({ db, registry: notificationTypes, jobs, email, logger });
  const usage = createUsageService({ db, authorizer, bus, jobs });
  const search = createSearchService({ authorizer, logger });
  const modules = createModuleService({ db, registry: moduleRegistry, authorizer, audit, bus, notifications });
  authorizer.setEntitlements(modules);
  const organizations = createOrganizationService({ db, authorizer, roles, audit, bus, resolveTxt: o.resolveTxt });
  const sessions = new SessionManager(db);
  const auth = createAuthService({
    db, sessions, organizations, roles, audit, bus, secrets, notifications, email, logger,
    config: { appUrl: env.APP_URL, environment: env.APP_ENV, allowSelfServeSignup: env.ALLOW_SELF_SERVE_SIGNUP, issuerName: env.PLATFORM_NAME },
  });
  const apiKeys = createApiKeyService({ db, authorizer, registry: permissionRegistry, audit, bus });
  const sso = createSsoService({ db, authorizer, roles, audit, bus, secrets, auth, appUrl: env.APP_URL, appSecret: env.APP_SECRET, urlGuard, fetchImpl: o.fetchImpl });

  const connectorCatalog = new ConnectorCatalog(defaultConnectorDefinitions({ includeSandbox: !isProd }));
  const connectorService = createConnectorService({
    db, catalog: connectorCatalog,
    adapters: [restApiAdapter, graphqlAdapter, outboundWebhookAdapter, ...(isProd ? [] : [sandboxAdapter]), ...(o.extraConnectorAdapters ?? [])],
    secrets, authorizer, audit, bus, usage, notifications, jobs, rateLimiter, logger, metrics, urlGuard, appUrl: env.APP_URL, appSecret: env.APP_SECRET, fetchImpl: o.fetchImpl,
  });

  const ai = createAIService({
    db, secrets, authorizer, policies: policyService, audit, bus, usage, rateLimiter, logger, metrics,
    providers: [
      anthropicProvider,
      createOpenAICompatibleProvider("openai", { allowPrivateNetworks: env.ALLOW_PRIVATE_NETWORK_EGRESS, fetchImpl: o.fetchImpl }),
      createOpenAICompatibleProvider("openai_compatible", { allowPrivateNetworks: env.ALLOW_PRIVATE_NETWORK_EGRESS, fetchImpl: o.fetchImpl }),
      createOpenAICompatibleProvider("azure_openai", { allowPrivateNetworks: env.ALLOW_PRIVATE_NETWORK_EGRESS, fetchImpl: o.fetchImpl }),
      createOpenAICompatibleProvider("local", { allowPrivateNetworks: true, fetchImpl: o.fetchImpl }),
      ...(isProd ? [] : [sandboxProvider]),
    ],
    env: env as unknown as Record<string, string | undefined>,
    environment: env.APP_ENV,
    retentionFor: async (orgId) => (await organizations.settingsInternal(orgId)).dataRetention.aiPromptRetention,
    isModuleEnabled: (orgId, moduleId) => (isModuleId(moduleId) ? modules.isEnabled(orgId, moduleId) : Promise.resolve(false)),
  });

  const health = createHealthService({ db, jobs, ai, modules, authorizer });

  // ── Core search providers ───────────────────────────────────────────────
  const like = (q: string) => `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  search.register({
    resourceType: "member",
    owner: "core",
    label: "People",
    permission: "user.read",
    async search(ctx, q, limit) {
      const rows = await db.withTenant({ organizationId: ctx.organizationId }, (tx) =>
        tx
          .select({ id: users.id, name: users.name, email: users.email })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(and(eq(memberships.organizationId, ctx.organizationId), eq(memberships.status, "active"), or(ilike(users.name, like(q)), ilike(users.email, like(q)))))
          .limit(limit),
      );
      return rows.map((r) => ({ resourceType: "member", id: r.id, title: r.name, subtitle: r.email, url: `/admin/users?focus=${r.id}`, score: textScore(q, r.name, r.email) }));
    },
  });
  search.register({
    resourceType: "connector",
    owner: "core",
    label: "Connectors",
    permission: "connector.read",
    async search(ctx, q, limit) {
      const rows = await db.withTenant({ organizationId: ctx.organizationId }, (tx) =>
        tx.select().from(connectors).where(and(eq(connectors.organizationId, ctx.organizationId), or(ilike(connectors.name, like(q)), ilike(connectors.type, like(q))))).limit(limit),
      );
      return rows.map((r) => ({ resourceType: "connector", id: r.id, title: r.name, subtitle: `${r.type} · ${r.status}`, url: `/admin/connectors/${r.id}`, score: textScore(q, r.name, r.type) }));
    },
  });
  search.register({
    resourceType: "policy",
    owner: "core",
    label: "Policies",
    permission: "policy.read",
    async search(ctx, q, limit) {
      const rows = await db.withTenant({ organizationId: ctx.organizationId }, (tx) =>
        tx.select().from(policies).where(and(eq(policies.organizationId, ctx.organizationId), or(ilike(policies.name, like(q)), ilike(policies.key, like(q))))).limit(limit),
      );
      return rows.map((r) => ({ resourceType: "policy", id: r.id, title: r.name, subtitle: `${r.kind} · ${r.status}`, url: `/admin/policies/${r.key}`, score: textScore(q, r.name, r.key) }));
    },
  });

  // ── Install modules into the shared registries ──────────────────────────
  for (const m of o.modules ?? MODULE_MANIFESTS) {
    moduleRegistry.add(m);
    permissionRegistry.register(m.id, m.permissions);
    for (const [role, patterns] of Object.entries(m.roleGrants ?? {})) roleGrants[role] = [...(roleGrants[role] ?? []), ...(patterns ?? [])];
    for (const e of m.events ?? []) {
      if (e.owner !== m.id) throw new Error(`Module ${m.id} declares event ${e.type} owned by ${e.owner}`);
      eventRegistry.register(e);
    }
    for (const t of m.notificationTypes ?? []) notificationTypes.register({ ...t, owner: m.id });
    for (const s of m.searchProviders ?? []) search.register({ ...s, owner: m.id });
    for (const k of m.policyKinds ?? []) policyService.registerKind({ ...k, owner: m.id });
  }

  // ── Core event subscribers ──────────────────────────────────────────────
  bus.subscribe("usage.threshold.exceeded", "core.usage.notify", async (e) => {
    if (!e.organizationId) return;
    const p = e.payload as { metric: string; limit: number; current: number; period: string };
    await notifications.notify(
      { organizationId: e.organizationId, actor: { type: "system", id: "usage", label: "system:usage" }, correlationId: e.correlationId ?? e.id },
      { type: "core.usage_threshold", title: `Usage limit reached: ${p.metric}`, body: `${p.current.toFixed(2)} of ${p.limit} for ${p.period}.`, actionUrl: "/admin/usage", recipients: { permission: "usage.read" } },
    );
  });

  return {
    env, db, logger, metrics, tracer, errors, secrets, rateLimiter, audit, jobs,
    events: { registry: eventRegistry, bus, webhooks },
    rbac: { registry: permissionRegistry, authorizer, roles },
    policies: policyService, policyEngine, notifications, notificationTypes, usage, search, modules, moduleRegistry,
    organizations, auth, sessions, apiKeys, sso,
    connectors: connectorService, connectorCatalog, ai, health,
    async bootstrap() {
      await roles.syncCatalog();
      await modules.syncCatalog();
      await ai.syncCatalog();
    },
    close: () => db.close(),
  };
}
