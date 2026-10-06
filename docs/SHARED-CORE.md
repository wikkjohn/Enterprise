# Shared Core Packages

Every package is a workspace package named `@eaop/<dir>` exporting TypeScript source from `src/index.ts`. Modules and apps consume these through `createPlatform()`; they never construct their own infrastructure.

Dependency order (lower depends on nothing above it): `shared-types` → `observability` → `security` → `db` → `secrets`, `audit`, `jobs` → `events` → `rbac` → `policies`, `notifications`, `usage`, `search` → `module-registry`, `organizations` → `auth`, `connectors`, `ai` → `platform` → `api`.

---

## `@eaop/shared-types` — `packages/shared-types/src`

Purpose: the cross-cutting vocabulary.

| Export | File | Notes |
|---|---|---|
| `ErrorCodes`, `ErrorCode`, `AppError`, `isAppError(err, code?)`, `notFound`, `forbidden`, `conflict`, `notConfigured` | `errors.ts` | Every service throws `AppError(code, message?, details?, { cause, retryable })`; status comes from `ErrorCodes`. Identify errors with `isAppError()` (brand `Symbol.for("eaop.AppError")`), never `instanceof`: the Next.js bundle can load two copies of a workspace module |
| `Actor`, `ActorType` (`user`/`api_key`/`system`/`agent`), `TenantContext`, `PlatformContext`, `RequestMeta`, `SYSTEM_ACTOR(component)` | `context.ts` | `TenantContext.cache` memoizes effective permissions per request |
| `MODULE_IDS`, `ModuleId`, `OwnerId` (`ModuleId \| "core"`), `isModuleId` | `modules.ts` | Stable module ids — never rename |
| `pageQuerySchema`, `Page<T>`, `encodeCursor`/`decodeCursor`, `MAX_PAGE_SIZE` (200), `DEFAULT_PAGE_SIZE` (50), `sortDirectionSchema` | `pagination.ts` | Keyset cursors are base64url JSON `{ t, id }` |
| `POLICY_EFFECTS`, `PolicyEffect`, `POLICY_EFFECT_PRECEDENCE` | `policy.ts` | `ALLOW < REQUIRE_APPROVAL < ESCALATE < DENY` |
| `Uuid`, `JsonValue`, `RiskLevel`, `Priority`, `HealthState`, `HealthStatus`, `isUuid` | `common.ts` | |

## `@eaop/observability` — `packages/observability/src`

| Export | Purpose |
|---|---|
| `createLogger({ level, sink, bindings })`, `Logger`, `stdoutSink`, `MemorySink` | JSON lines; `warn`/`error` to stderr; adds `correlationId`, `organizationId`, `actorId` from the correlation scope; fields pass through `redact()` |
| `runWithCorrelation`, `currentCorrelation`, `newCorrelationId`, `sanitizeCorrelationId` | AsyncLocalStorage correlation scope |
| `createMetrics()`, `Metrics` (`increment`, `observe`, `snapshot`, `toPrometheus`) | In-process counters/histograms (buckets 5 ms … 30 s) |
| `createTracer({ logger, metrics })`, `Tracer.span(name, fn, attrs)` | OTel-shaped span helper; records `eaop_span_duration_ms` |
| `redact`, `redactString`, `REDACTED` | Masks sensitive keys and credential-looking values |

Extension points: implement `LogSink`; implement `Metrics` on an OpenTelemetry MeterProvider; implement `Tracer` with an OTel tracer. See [OBSERVABILITY.md](OBSERVABILITY.md).

## `@eaop/security` — `packages/security/src`

| Export | File | Purpose |
|---|---|---|
| `hashPassword`, `verifyPassword`, `dummyPasswordHash`, `checkPasswordPolicy`, `PasswordPolicy` | `password.ts` | scrypt `scrypt$N$r$p$salt$hash`, NFKC normalization; NIST-style policy |
| `generateTotpSecret`, `totpCode`, `verifyTotp`, `totpUri`, `base32Encode/Decode` | `totp.ts` | RFC 6238, SHA-1, 30 s, 6 digits, ±1 step |
| `verifyCsrf`, `SESSION_COOKIE` (`eaop_session`), `CSRF_COOKIE` (`eaop_csrf`), `CSRF_HEADER` (`x-csrf-token`) | `csrf.ts`, `headers.ts` | Origin + double-submit check |
| `securityHeaders({ isProduction })`, `sessionCookieAttributes` | `headers.ts` | CSP, frame denial, HSTS in production |
| `RateLimiter`, `MemoryRateLimiter`, `RATE_LIMITS` (`login`, `api`, `ai`, `connector`) | `rate-limit.ts` | Token bucket |
| `assertSafeOutboundUrl`, `isPrivateAddress`, `UrlGuardOptions` | `url-guard.ts` | SSRF guard |
| `ipAllowed` | `cidr.ts` | IPv4 CIDR + exact IPv6 matching |
| `randomToken`, `sha256`, `hmacSha256`, `constantTimeEqual`, `hashBucket` | `crypto.ts` | |

Extension point: `RateLimiter` (shared limiter for multi-instance deployments).

## `@eaop/db` — `packages/db`

| Export | Purpose |
|---|---|
| `createDatabase({ connectionString, max, onAfterCommitError })` → `Database` | `withTenant`, `withUser`, `withSystem`, `afterCommit`, `lockKey`, `currentScope`, `pool`, `close` |
| `scopeOf(ctx)` | `TenantContext` → `{ organizationId, userId? }` |
| `DbScope`, `Tx`, `Db` | Types |
| Table objects (`organizations`, `users`, `connectors`, …) and `schema` | Drizzle schema in `src/schema/{tenancy,identity,rbac,integration,governance}.ts` |
| Re-exported operators: `sql, eq, ne, and, or, not, desc, asc, inArray, isNull, isNotNull, gt, gte, lt, lte, ilike, like, count, sum` | Import these from `@eaop/db`, not `drizzle-orm` |
| `runMigrations`, `MigrationSource`, `CORE_MIGRATIONS_DIR` | Migration runner |

Scripts: `packages/db/scripts/migrate.ts` (`pnpm db:migrate`), `reset.ts` (`pnpm db:reset`, refuses in production), `module-migrations.ts` (discovers `modules/*/migrations`). See [DATABASE.md](DATABASE.md).

## `@eaop/secrets` — `packages/secrets/src/index.ts`

| Export | Purpose |
|---|---|
| `SecretStore` (`put`, `get`, `rotate`, `destroy`) | Provider-agnostic interface; the DB stores references only |
| `parseSecretRef` | `secret://<provider>/<org-uuid\|platform>/<id>#v<version>` |
| `LocalEncryptedSecretStore` | AES-256-GCM in `dev_secret_values`, AAD = the reference; refuses `APP_ENV=production` unless `ALLOW_LOCAL_SECRETS_IN_PRODUCTION=true` |
| `UnconfiguredSecretStore` | `aws`/`azure`/`vault`/`gcp` — every call throws `NOT_CONFIGURED` |
| `createSecretStore(db, env)` | Chooses by `SECRETS_PROVIDER` |
| `secretHint(value)` | `••••` + last 4 characters |

Tenant binding: `get/rotate/destroy` throw `FORBIDDEN` when the reference's owner segment differs from the caller's organization. Extension point: implement `SecretStore` for a managed secret manager ([CONNECTORS.md](CONNECTORS.md#secret-managers)).

## `@eaop/audit` — `packages/audit/src/index.ts`

`createAuditService({ db, logger })` → `record`, `recordDetached`, `recordPlatform`, `query`; plus `AuditActions`, `auditQuerySchema`, `AuditEventView`. See [AUDIT.md](AUDIT.md).

## `@eaop/jobs` — `packages/jobs/src/index.ts`

`createJobQueue({ db, logger, metrics })` → `JobQueue`:

| Method | Behaviour |
|---|---|
| `register(handler)` | `{ type, maxAttempts?, timeoutMs? (default 60 000), handle(job) }`; duplicate types throw |
| `enqueue(type, payload, { organizationId, queue, runAt, idempotencyKey, maxAttempts, correlationId })` | Joins the caller's tenant transaction when the org matches; otherwise system scope. `ON CONFLICT (type, idempotency_key) DO NOTHING` → returns `null` for duplicates |
| `runOnce(workerId, { queue, batch })` | Resets jobs locked > 15 min, claims due `queued`/`failed` jobs `FOR UPDATE SKIP LOCKED`, runs with timeout |
| `stats()`, `recentFailures(limit, orgId?)`, `retryDead(id)`, `registeredTypes()` | Ops helpers |
| `backoffSeconds(attempt)` | `min(3600, 5·2^(attempt-1))` ± 20 % jitter |

A job becomes `dead` when `attempts >= maxAttempts` or it throws a non-retryable `AppError` (other than `UPSTREAM_TIMEOUT`/`UPSTREAM_ERROR`). Handlers must be idempotent (at-least-once). Registered job types: `events.redeliver`, `webhooks.deliver`, `notifications.email`, `usage.threshold_alert`, `connectors.credential_expiring`, `connectors.health_sweep`, and in the worker `maintenance.retention`.

## `@eaop/events` — `packages/events/src`

| Export | File | Purpose |
|---|---|---|
| `EventContract`, `EventRegistry`, `PlatformEvent` | `contracts.ts` | Types must match `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`; one owner per type; breaking payload changes bump `version` |
| `CORE_EVENTS` | `core-events.ts` | 22 core contracts (see below) |
| `createEventBus(...)` → `publish`, `publishPlatform`, `subscribe(type \| "*", name, handler)`, `dispatchPending(limit)` | `bus.ts` | Transactional outbox |
| `createWebhookService(...)` → `create`, `list`, `remove` (audited as `webhook.created` / `webhook.deleted` through an injected `audit` callback); `signWebhook`, `WEBHOOK_SIGNATURE_HEADER` | `webhooks.ts` | Tenant webhooks |

Core event types: `organization.created`, `organization.updated`, `user.invited`, `user.joined`, `user.suspended`, `role.assigned`, `role.revoked`, `module.enabled`, `module.disabled`, `connector.created`, `connector.updated`, `connector.deleted`, `connector.failed`, `connector.health_changed`, `credential.rotated`, `credential.expiring`, `policy.activated`, `ai.run.completed`, `ai.run.failed`, `usage.threshold.exceeded`, `api_key.created`, `api_key.revoked` (the last two have `externallyVisible: false` and are never sent to webhooks).

Outbox rows are marked `dead` after 10 failed dispatch attempts; failed rows are retried after `30 s × attempts`. Rows stuck in `dispatching` for 10 minutes are reset by `dispatchPending`.

Webhooks: `create` validates the URL with the SSRF guard and every event type against the registry (or `*`), generates a `whsec_…` signing secret stored in the secret store and returns it once. A `*` bus subscriber (`core.webhooks.fanout`) enqueues one `webhooks.deliver` job per matching active webhook. Delivery POSTs `{ id, type, version, occurredAt, organizationId, data }` with headers `x-eaop-event`, `x-eaop-delivery`, `x-eaop-signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`, no redirects, 10 s timeout, up to 8 attempts; a webhook is disabled after 20 consecutive failures.

## `@eaop/rbac` — `packages/rbac/src`

`PermissionRegistry`, `CORE_PERMISSIONS`, `PERMISSION_KEY_RE`, `SYSTEM_ROLES`, `SYSTEM_ROLE_KEYS`, `SOD_CONSTRAINTS`, `createAuthorizer`, `createRoleService`, `roleKeySchema`, `createRoleSchema`, `assignRoleSchema`. Extension points: `authorizer.registerActorResolver(actorType, resolver)`, manifest `permissions` and `roleGrants`. See [RBAC.md](RBAC.md).

## `@eaop/organizations` — `packages/organizations/src/index.ts`

`createOrganizationService(...)` → `create`, `listAll`, `setStatus` (platform-level, `PlatformContext`); `get`, `update`, `settings`, `settingsInternal`, `updateSecurity`, `updateRetention`, `updateUsageLimits`, `listDomains`, `addDomain`, `verifyDomain`, `listMembers`, `setMemberStatus`, `invite`, `listInvitations`, `revokeInvitation`, `listForUser`. Also `DEFAULT_SECURITY`, `DEFAULT_RETENTION`, `slugSchema`, `createOrganizationSchema`, `securitySettingsSchema`, `retentionSettingsSchema`, `usageLimitsSchema`.

| Setting (`organization_settings.security`) | Default | Bounds |
|---|---|---|
| `mfaRequired` | `false` | |
| `sessionIdleMinutes` | 60 | 5 – 1440 |
| `sessionMaxHours` | 12 | 1 – 720 (capped at 168 by `ABSOLUTE_SESSION_HOURS`) |
| `passwordMinLength` | 12 | 12 – 128 |
| `allowedEmailDomains` | `[]` | ≤ 50 |
| `ipAllowlist` | `[]` | ≤ 200 |
| `ssoEnforced` | `false` | |

| Setting (`data_retention`) | Default | Bounds |
|---|---|---|
| `auditDays` | 2555 | 90 – 3650 |
| `aiPromptRetention` | `metadata` | `none` / `metadata` / `full` |
| `aiRunDays` | 365 | 7 – 3650 |
| `notificationDays` | 180 | 7 – 3650 |
| `usageDays` | 1095 | 30 – 3650 |

Domain verification: `addDomain` returns a TXT record `eaop-verification=<token>` to publish at `_eaop-verification.<domain>`; `verifyDomain` resolves it via DNS. Domains are globally unique. Invitations expire after 7 days; the raw token is returned once (the API turns it into `acceptUrl`).

## `@eaop/auth` — `packages/auth/src`

`SessionManager`, `ABSOLUTE_SESSION_HOURS`; `createAuthService` (`login`, `verifyMfa`, `logout`, `resolve`, `switchOrganization`, `acceptInvitation`, `describeInvitation`, `signup`, `bootstrapPlatformAdmin`, `changePassword`, `requestPasswordReset`, `resetPassword`, `beginMfaEnrollment`, `confirmMfaEnrollment`, `disableMfa`, `listSessions`, `revokeSession`, `createSessionForUser`); `createApiKeyService` (`create`, `list`, `revoke`, `authenticate`, `registerActorBinder` — lets a module map a verified key to its own actor type, first non-null wins, a throwing binder fails authentication closed); `createSsoService` (`list`, `configureOidc`, `configureSaml`, `setStatus`, `discover`, `startLogin`, `completeOidc`). See [AUTHENTICATION.md](AUTHENTICATION.md).

## `@eaop/module-registry` — `packages/module-registry/src`

`ModuleManifest`, `ModuleNavItem`, `ModuleFeatureFlag`, `ModuleRegistry` (`manifest.ts`); `createModuleService` → `isEnabled`, `syncCatalog`, `list`, `enable`, `disable`, `navigation`, `requireEnabled`, `isFlagEnabled`, `listFlags`, `setFlag`, `health`, `invalidate` (`service.ts`). Entitlement lookups are cached per org for 5 s. See [MODULE-SYSTEM.md](MODULE-SYSTEM.md).

## `@eaop/connectors` — `packages/connectors/src`

Types (`ConnectorDefinition`, `ConnectorAdapter`, `AdapterContext`, `ConnectorError`, `isConnectorError`, `classifyStatus`, `parseRetryAfter`), `ConnectorCatalog`, `defaultConnectorDefinitions`, adapters (`restApiAdapter`, `graphqlAdapter`, `outboundWebhookAdapter`, `sandboxAdapter`), `createGuardedFetch`, `definitionViolations`, `isNormalisedError`, `createConnectorService`. Extension: `PlatformOverrides.extraConnectorAdapters` + `ConnectorCatalog.register`. See [CONNECTORS.md](CONNECTORS.md).

## `@eaop/ai` — `packages/ai/src`

`AIProvider`, `AIGenerateRequest/Response`, `AIPolicyHook`, `PLATFORM_AI_CATALOG`, `UNIMPLEMENTED_PROVIDER_KINDS`, `rankModels`, `estimateCostUsd`, `RoutingPolicy`, `createAIService` (`execute`, `registerPolicyHook`, `registerRoutingPolicy`, `syncCatalog`, `listProviders`, `configureProvider`, `setProviderStatus`, `upsertModel`, `setModelStatus`, `listRuns`, `getRun`, `providerStatus`), `anthropicProvider`, `createOpenAICompatibleProvider`, `sandboxProvider`. See [AI-PROVIDERS.md](AI-PROVIDERS.md).

## `@eaop/policies` — `packages/policies/src`

`PolicyEngine` (`validate`, `evaluate`, `registerOperator`, `hasOperator`), `policyDefinitionSchema`, `policyRuleSchema`, `BUILTIN_OPERATORS` (`eq, neq, gt, gte, lt, lte, in, nin, contains, exists, starts_with, matches`), `getPath`, `PolicyKind`; `createPolicyService` → `registerKind`, `kinds`, `list`, `get`, `create`, `addVersion`, `activate`, `disable`, `simulate`, `evaluateKind`.

- Input: `{ subject, resource, action, context }`. Rules: `{ id, description, effect, actions?, when? }`; conditions nest `all` / `any` / `not` / `{ field, op, value }` with fields rooted at `subject|resource|action|context`.
- Combining: `deny-overrides` (default) or `first-match`; `defaultEffect` defaults to `DENY`.
- Safety: unknown operators fail validation and never match at runtime; `matches` regex ≤ 200 chars, input truncated to 10 000 chars; path resolution ignores `__proto__`, `prototype`, `constructor`.
- Versions are immutable (`policy_versions`); `activate(key, version)` points `policies.active_version` at one.
- `evaluateKind(ctx, kind, input, { defaultEffect })` evaluates every active policy of a kind and returns the most restrictive effect; with no active policy it returns `ALLOW` (or `defaultEffect`). It performs no permission check — it is for services enforcing policy on their own operations.
- `registerInterceptor(kind, name, fn)`: code-level checks that run inside `evaluateKind` for a kind after stored policies and combine deny-overrides (a throwing interceptor yields DENY; reasons are prefixed `[name]`; `policies` lists `interceptor:<name>`). Agent Governance uses it on `integration_action`.
- Built-in kinds: `access` (core) and `ai_usage` (registered by the AI service). Modules add kinds via `manifest.policyKinds` and operators via `platform.policyEngine.registerOperator("ns.op", fn)` (names must contain a dot).

## `@eaop/notifications` — `packages/notifications/src/index.ts`

`NotificationTypeRegistry`, `CORE_NOTIFICATION_TYPES`, `EmailSender`, `UnconfiguredEmailSender`, `WebhookEmailSender`, `notifyInputSchema`, `createNotificationService` → `notify`, `listMine`, `unreadCount`, `markRead`, `preferences`, `setPreference`.

| Core type | Priority | Channels | Mandatory |
|---|---|---|---|
| `core.invitation_accepted` | low | in_app | |
| `core.connector_failed` | high | in_app, email | |
| `core.credential_expiring` | high | in_app, email | |
| `core.security_alert` | critical | in_app, email | yes |
| `core.usage_threshold` | high | in_app, email | |
| `core.module_changed` | normal | in_app | |

Recipients: `userIds`, `roleKeys`, `permission` (org-wide grants only) and/or `allMembers`; only active members of the caller's org. `actionUrl` must be a relative path (`^\/(?!\/)`). Email is enqueued as a `notifications.email` job only when the type includes `email`, the user did not opt out, and an email sender is configured. The `webhook` channel exists in the type but has no delivery implementation.

## `@eaop/usage` — `packages/usage/src/index.ts`

`USAGE_METRICS`, `UsageRecord`, `usageSummarySchema`, `createUsageService` → `record`, `summary`, `monthToDate`. See [OBSERVABILITY.md](OBSERVABILITY.md#usage-metering).

## `@eaop/search` — `packages/search/src/index.ts`

`SearchProvider` (`resourceType`, `owner`, `label`, `permission`, `search(ctx, q, limit)`), `createSearchService` → `register`, `providers`, `query(ctx, q, { types, limit })`; `textScore`. `query` requires `search.use`, a query ≥ 2 chars (trimmed to 200), checks each provider's `permission` (which includes module entitlement for module-owned permissions), runs providers in parallel with a 2 s timeout each, drops hits whose `url` is not a relative path, sorts by `score`, caps at 50. Providers must query through tenant-scoped DB access.

## `@eaop/platform` — `packages/platform/src`

| Export | File |
|---|---|
| `envSchema`, `loadEnv`, `PlatformEnv` | `config.ts` |
| `createPlatform`, `Platform`, `PlatformOverrides`, `ModuleDefinition` | `platform.ts` (module list: `@eaop/module-catalog`) |
| `createHealthService` (`probe`, `report`), `HealthReport` | `health.ts` |
| `createErrorReporter`, `ErrorReporter`, `ErrorSink` | `errors.ts` |
| `runRetention(platform)` | `maintenance.ts` |

## `@eaop/api` — `packages/api/src`

`createRouteFactory(getPlatform)` → `route(options)`; `AuthMode`, `RouteOptions`, `RouteArgs`, `RouteHandler`; `json`, `errorResponse`, `parseCookies`, `serializeCookie`, `clientIp` (`http.ts`). Framework-agnostic: handlers take a standard `Request` and return a `Response`. See [DEVELOPER-GUIDE.md](DEVELOPER-GUIDE.md#route-options).

## `@eaop/design-system` — `packages/design-system`

Tailwind v4 theme tokens in `src/styles.css` (`@theme` variables such as `--color-background`, `--color-accent`; light and dark themes) and accessible React components exported from `src/index.ts`, including `Button`, `Form` controls, `Card`, `PageHeader`, `Badge`, `States` (e.g. `NotInstalledState`), `DataTable`, `FilterBar`, `BarChart`/`LineChart`/`Sparkline`/`StatCard`, `Modal`, `Drawer`, `ConfirmDialog`, `CommandPalette`, `Menu`, `Toast`, `Tabs`, `SidebarNav`, plus hooks (`useHotkey`, `useFocusTrap`). Apps import `@eaop/design-system/styles.css` after `@import "tailwindcss"` (see `apps/web/src/app/globals.css`).
