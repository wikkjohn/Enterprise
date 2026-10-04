# Architecture

## Layers

| Layer | Location | Responsibility | May depend on |
|---|---|---|---|
| Delivery | `apps/web` (UI pages in `src/app/(auth)` and `src/app/(app)`, `/api/v1` route handlers), `apps/worker` | HTTP, cookies, Server Components, client components, background loop | `@eaop/platform`, `@eaop/api`, `@eaop/design-system` |
| HTTP kit | `packages/api` | `route()` wrapper: auth, CSRF, rate limit, entitlement, permission, validation, idempotency, envelopes | `@eaop/platform` and below |
| Composition root | `packages/platform` | `createPlatform(env)` builds every service once, installs module manifests, exposes `bootstrap()` | all core packages, `modules/*` |
| Domain services | `packages/{auth,organizations,rbac,module-registry,connectors,ai,policies,notifications,usage,search}` | Business rules; every tenant call takes a `TenantContext` | infrastructure packages |
| Infrastructure | `packages/{db,audit,jobs,events,secrets,security,observability}` | Persistence, RLS scoping, queue, outbox, crypto, logging | `shared-types` |
| Contracts | `packages/shared-types` | `AppError`/`ErrorCodes`, `TenantContext`/`Actor`, pagination, `MODULE_IDS`, policy effects | `zod` only |
| Modules | `modules/*` | `ModuleManifest` declarations (placeholders today) | `@eaop/module-registry`, `@eaop/shared-types` |

All packages ship TypeScript source (`"exports": { ".": "./src/index.ts" }`); Next.js transpiles them (`transpilePackages` in `apps/web/next.config.ts`), the worker and scripts run through `tsx`.

## Composition root

`createPlatform(env, overrides?)` in `packages/platform/src/platform.ts`:

1. Creates logger, metrics, tracer, the `Database` (`createDatabase` over `DATABASE_URL`), error reporter, URL guard options, secret store (`createSecretStore`), rate limiter (`MemoryRateLimiter` unless overridden), audit service and job queue.
2. Creates the shared registries: `PermissionRegistry` (seeded with `CORE_PERMISSIONS`), `EventRegistry` (`CORE_EVENTS`), `NotificationTypeRegistry` (`CORE_NOTIFICATION_TYPES`), `ModuleRegistry`, `PolicyEngine`.
3. Wires services in dependency order: event bus → webhooks → authorizer → role service → policy service → email sender → notifications → usage → search → module service (`authorizer.setEntitlements(modules)`) → organizations → sessions/auth → API keys → SSO → connector catalog + service → AI service → health service.
4. Registers core search providers (`member`, `connector`, `policy`).
5. Installs each module manifest (default `MODULE_MANIFESTS`) into the shared registries — permissions, role grants, events, notification types, search providers, policy kinds. See [MODULE-SYSTEM.md](MODULE-SYSTEM.md).
6. Subscribes `core.usage.notify` to `usage.threshold.exceeded`.

`platform.bootstrap()` syncs code registrations to the database (idempotent): `roles.syncCatalog()` (permissions + system roles, under an advisory transaction lock), `modules.syncCatalog()`, `ai.syncCatalog()`.

The web app holds one instance per process (`apps/web/src/lib/platform.ts`, cached on `globalThis`); the worker and scripts create their own.

`PlatformOverrides` (`db`, `logger`, `logSink`, `fetchImpl`, `email`, `rateLimiter`, `modules`, `extraConnectorAdapters`, `urlGuard`, `resolveTxt`) exist for tests and for swapping infrastructure.

## Request lifecycle

Every handler under `apps/web/src/app/api/v1` is built with `route({...})` from `apps/web/src/lib/api.ts`, which is `createRouteFactory(getPlatform)` from `packages/api/src/route.ts`. Steps, in order:

| # | Step | Detail |
|---|---|---|
| 1 | Request id | `x-request-id` accepted if it matches `^[A-Za-z0-9._:-]{8,128}$` (`sanitizeCorrelationId`), else a UUID; the whole request runs in `runWithCorrelation` |
| 2 | Meta | `clientIp(req)` = last `x-forwarded-for` entry (or `x-real-ip`); user agent; cookies parsed |
| 3 | Login-CSRF | `auth: "public"` + mutating method + an `Origin` header not equal to `APP_URL`'s origin → `CSRF_FAILED` |
| 4 | Authentication | `public`: none. `any` + `Authorization: Bearer eaop_...`: `apiKeys.authenticate` → API-key actor (no CSRF). Otherwise: `eaop_session` cookie required, `verifyCsrf` (origin/referer + `x-csrf-token` == `eaop_csrf` cookie for mutating methods), `auth.resolve(token)` |
| 5 | MFA gate | Org requires MFA and user not enrolled → `MFA_REQUIRED` unless `allowDuringMfaEnrollment` |
| 6 | Tenant gate | `auth: "session"` without an active organization → `FORBIDDEN` |
| 7 | Rate limit | Authenticated routes without a custom rule share the per-actor bucket `api:<org>:<actor>` (`RATE_LIMITS.api`, 600/60 s); routes with `opts.rateLimit`, and all public routes, get their own bucket keyed by `<actor or ip>:<METHOD>:<path>` |
| 8 | Entitlement | `opts.module` → `modules.requireEnabled` (`MODULE_NOT_ENABLED`) |
| 9 | Authorization | `opts.permission` → `authorizer.require` (denials audited) |
| 10 | Validation | JSON body ≤ 2 MB, `Content-Type: application/json`, parsed with `opts.body` zod schema; query parsed with `opts.query` |
| 11 | Idempotency | `opts.idempotent` + `Idempotency-Key` header on a mutating method → stored per `(organization_id, actorId:key)` with request hash; replay returns the stored response with `idempotent-replayed: true` |
| 12 | Handler | Receives `{ req, platform, params, body, query, meta, ctx, session, cookies, setCookie }`; non-`Response` results are wrapped as `{ data }` with 201 for POST else 200 (override with `status`) |
| 13 | Usage | API-key requests record `api.requests` with a normalized endpoint |
| 14 | Errors | `AppError` → its status/code; `ZodError` → 422 `VALIDATION_FAILED` with issues; anything else → 500 `INTERNAL` with no message detail, reported via `platform.errors.report` |
| 15 | Response | Adds `x-request-id`, `cache-control: no-store` (if unset), `Set-Cookie`s; emits `eaop_http_requests_total`, `eaop_http_request_duration_ms` and an `http.request` log line |

Services re-check authorization themselves (`authorizer.require` at the top of each tenant method), so a route's `permission` is defence in depth, not the only check.

## Data flow and tenancy

Tenant identity comes only from the authenticated context (`TenantContext.organizationId`); services never accept an organization id from request bodies. Every DB access goes through `db.withTenant(scopeOf(ctx), fn)`, `db.withUser(userId, fn)` or `db.withSystem(reason, fn)`, which set transaction-local GUCs that PostgreSQL RLS policies read. Details in [DATABASE.md](DATABASE.md).

## Synchronous vs asynchronous work

| Mechanism | Use for | Guarantees |
|---|---|---|
| Direct service call | Request/response work (CRUD, authorization, AI execute, connector execute) | In the caller's transaction when nested (`withTenant` re-entrancy) |
| `bus.publish(ctx, type, payload)` | Facts other parts of the system react to | Payload validated against the registered zod contract; row written to `event_outbox` in the caller's transaction; dispatched in-process after commit; worker re-dispatches pending/failed rows; at-least-once |
| `jobs.enqueue(type, payload, opts)` | Deferred or retryable work (webhook delivery, email, credential-expiry alerts, sweeps, retention) | Transactional with the caller when in the same tenant scope; `FOR UPDATE SKIP LOCKED` claiming; exponential backoff with jitter; dead-letter after `maxAttempts`; idempotency keys dedupe enqueues |
| `db.afterCommit(fn)` | Side effects that must only happen if the transaction commits | Runs after commit; errors go to `onAfterCommitError` |

A failing event subscriber is retried individually via an `events.redeliver` job (idempotency key `<eventId>:<subscriber>`), so other subscribers are not re-run.

## Technology choices

| Choice | Why |
|---|---|
| **PostgreSQL 16 + Row-Level Security** | Tenant isolation enforced by the database, not only by application code; `FORCE ROW LEVEL SECURITY` applies to the table owner too |
| **Drizzle ORM instead of Prisma** | No native query-engine binaries to ship; first-class transaction control so each transaction can run `set_config(..., true)` for the RLS GUCs before any query and nested calls can reuse the same transaction via AsyncLocalStorage |
| **Hand-written SQL migrations + a ~50-line runner** (`packages/db/src/migrate.ts`) | RLS policies, roles, triggers and SECURITY DEFINER functions are plain SQL; the runner adds per-owner history (`schema_migrations(owner, name)`) so module migrations stay separate |
| **PostgreSQL-backed job queue and event outbox** instead of Redis/BullMQ | No extra infrastructure; enqueue/publish are transactional with the business write; `SKIP LOCKED` makes multiple worker replicas safe. `JobQueue` is an interface and can be re-implemented on SQS/Cloud Tasks/BullMQ |
| **In-memory token-bucket rate limiter** | Correct for one instance; the `RateLimiter` interface is the extension point for a shared (e.g. Redis) limiter, which is not implemented |
| **Next.js 15 App Router, single deployable** | UI and `/api/v1` ship together; there is deliberately no `apps/api`. `packages/api` is framework-agnostic (standard `Request`/`Response`) and can be mounted in another server |
| **zod** | One schema language for request validation, event contracts, env config and policy definitions |
| **Opaque server-side sessions** | Revocation, idle timeout and org policy are enforced on every request; only SHA-256 hashes are stored |
| **Official `@anthropic-ai/sdk`** | Typed errors and request shapes; only `packages/ai/src/providers/**` may import provider SDKs (ESLint `no-restricted-imports`) |
| **scrypt (Node `crypto`)** | No native bcrypt/argon2 dependency; OWASP parameters N=2^17, r=8, p=1 |
| **`jose`** | JWKS fetching/caching and JWT verification for OIDC |

## Repository assessment

- The platform was first built under `platform/` in an unrelated repository (`wikkjohn/LicensedExchange`, a static marketplace site) and was moved here with its commit history (`git subtree split`); it shares no code with that site. The monorepo root is the repository root. CI is `.github/workflows/ci.yml`.
- The six modules are placeholders: manifests reserve ids, route prefixes, permission keys, navigation and event names (`RESERVED_EVENT_TYPES`) only.

### Technical debt and known gaps

| Item | Where | Impact |
|---|---|---|
| Rate limiter is per process | `packages/security/src/rate-limit.ts` | Limits multiply by replica count; `REDIS_URL` is reserved and not read |
| Secret managers other than `local` are stubs | `packages/secrets/src/index.ts` | Production requires implementing `SecretStore` (or `ALLOW_LOCAL_SECRETS_IN_PRODUCTION=true`) |
| `Tracer` is created but not called anywhere | `packages/observability/src/tracing.ts` | No spans are emitted yet |
| SAML sign-in, SCIM, MFA recovery codes | `packages/auth` | Not implemented |
