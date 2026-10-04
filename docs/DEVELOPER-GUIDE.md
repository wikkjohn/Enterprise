# Developer Guide

## Coding conventions

- **TypeScript strict** (`tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `isolatedModules`, `moduleResolution: Bundler`). ESM everywhere (`"type": "module"`).
- **Packages export source**: `"exports": { ".": "./src/index.ts" }`; import across packages by name (`@eaop/db`), never by relative path (tests are the exception and import `../../packages/*/src`).
- **Type imports**: `@typescript-eslint/consistent-type-imports` with inline style — `import { type Foo, bar } from "..."`.
- **Unused variables** are errors unless prefixed with `_`.
- **No `console.log`** (only `warn`/`error`), except in `**/scripts/**` and `apps/worker/**`. Use `platform.logger`.
- **Errors**: throw `AppError(code, message?, details?)` or the helpers `notFound`, `forbidden`, `conflict`, `notConfigured`. Messages and `details` may reach clients — no secrets, no stack traces, no SQL.
- **Validation**: zod at the route boundary *and* inside services (services are called from Server Components, jobs and modules too).
- **Tenant context**: every tenant service method takes `ctx: TenantContext` first and calls `authorizer.require` before doing anything else. Never take an organization id from input.
- **DB access**: `db.withTenant(scopeOf(ctx), tx => ...)`; query operators from `@eaop/db` (`eq`, `and`, `sql`, …). Use `withSystem("<area>.<reason>", ...)` only for genuinely platform-level work.
- **Side effects**: state change + `audit.record` + `bus.publish` inside the same `withTenant` callback so they commit together.

## API conventions

### Versioning and transport

All endpoints live under `/api/v1` (`apps/web/src/app/api/v1/**/route.ts`). JSON only: request bodies require `Content-Type: application/json` and are limited to 2 MB. Responses carry `cache-control: no-store` by default.

### Envelopes (`packages/api/src/http.ts`)

```json
// success
{ "data": <result> }                         // optional "meta" when json(data, { meta }) is used
// error
{ "error": { "code": "VALIDATION_FAILED", "message": "Request validation failed.",
             "details": { "issues": [{ "path": "name", "message": "Required" }] },
             "requestId": "8c0e…" } }
```

Status defaults: `POST` → 201, other methods → 200; routes override with `status` (actions such as `/test`, `/execute`, `/activate` use 200). Handlers may return a raw `Response` (CSV export, redirects, health probe), which bypasses the envelope.

### Error codes (`packages/shared-types/src/errors.ts`)

| Code | HTTP | Default message |
|---|---|---|
| `UNAUTHENTICATED` | 401 | Authentication required. |
| `MFA_REQUIRED` | 401 | Multi-factor authentication required. |
| `FORBIDDEN` | 403 | You do not have permission to perform this action. |
| `MODULE_NOT_ENABLED` | 403 | This module is not enabled for your organization. |
| `ORGANIZATION_SUSPENDED` | 403 | This organization is suspended. |
| `CSRF_FAILED` | 403 | Request origin could not be verified. |
| `POLICY_DENIED` | 403 | The action was denied by policy. |
| `NOT_FOUND` | 404 | Resource not found. |
| `CONFLICT` | 409 | The resource is in a conflicting state. |
| `IDEMPOTENCY_CONFLICT` | 409 | Idempotency key was reused with a different request. |
| `VALIDATION_FAILED` | 422 | Request validation failed. |
| `RATE_LIMITED` | 429 | Too many requests. (`Retry-After` header set from `details.retryAfterSeconds`) |
| `INTERNAL` | 500 | An internal error occurred. |
| `NOT_CONFIGURED` | 501 | This capability requires configuration that is not present. |
| `NOT_IMPLEMENTED` | 501 | This capability is not implemented yet. |
| `UPSTREAM_ERROR` | 502 | An upstream system returned an error. |
| `UPSTREAM_TIMEOUT` | 504 | An upstream system timed out. |
| `APPROVAL_REQUIRED` | 202 | The action requires approval. (returned as an **error envelope** with status 202) |

Unknown exceptions are always `500 INTERNAL` with the generic message; zod errors from services become `422` with up to 20 issues.

### Pagination, filtering, sorting

- Keyset pagination for logs: `?limit=&cursor=`; responses are `Page<T>` = `{ data: T[], nextCursor?: string }`, so on the wire `{ "data": { "data": [...], "nextCursor": "…" } }`. Cursors are opaque base64url `(timestamp, id)`; pass them back unchanged. Used by `GET /audit` (limit ≤ 500), `GET /ai/runs` (≤ 200), `GET /notifications` (≤ 100).
- Other list endpoints (members, connectors, roles, policies, API keys, webhooks, invitations) return arrays (members capped at 1000, invitations at 500).
- Filtering is by explicit query parameters per endpoint (e.g. audit `action`, `module`, `actorId`, `resourceType`, `resourceId`, `outcome`, `from`, `to`, `q`; members `search`, `status`; usage `from`, `to`, `groupBy`, `metric`, `moduleId`).
- Sorting is fixed per endpoint (logs newest first by `(timestamp, id)`); there is no generic `sort` parameter (`sortDirectionSchema` exists in shared-types but is unused).

### Idempotency

Routes declared `idempotent: true` (`POST /connectors`, `POST /connectors/:id/execute`) honour `Idempotency-Key` (`^[A-Za-z0-9_.:-]{8,128}$`) on mutating methods for tenant-authenticated callers. The key is scoped per organization and actor; the first request stores a hash of `METHOD path body`; a retry with the same key and body replays the stored status/body with header `idempotent-replayed: true`; a different body → `409 IDEMPOTENCY_CONFLICT`; a retry while the first is still running → `409 CONFLICT`. Records get a 24 h `expires_at` and are deleted by the daily retention job once expired (the replay lookup itself does not check expiry). A first attempt that fails with an error stores no response, so retries with that key get `409 CONFLICT` until the record is purged — use a new key after an error.

### Request ids

Send `x-request-id` (8–128 chars of `A-Za-z0-9._:-`) to correlate; otherwise one is generated. It is echoed in the `x-request-id` header and `error.requestId`, and stored on audit events and AI runs.

### Rate limiting

Default `RATE_LIMITS.api` = 600 requests / 60 s per `(organization, actor)`; public routes are keyed by `(IP, path)`. Routes can set `rateLimit`. On limit: `429 RATE_LIMITED` + `Retry-After`.

## Route options

`route(options)` from `apps/web/src/lib/api.ts` (= `createRouteFactory(getPlatform)`):

| Option | Meaning |
|---|---|
| `auth` | `public` (no auth; foreign-`Origin` mutations rejected), `session` (cookie session **with** active org), `session_any` (cookie session, org optional — `ctx` may be undefined), `any` (session or `Authorization: Bearer eaop_…`) |
| `permission?` | Checked with `authorizer.require` (includes module entitlement for module-owned permissions; denials audited) |
| `module?` | `modules.requireEnabled` → `MODULE_NOT_ENABLED` |
| `body?`, `query?` | zod schemas; parsed values arrive typed in `body` / `query` |
| `rateLimit?` | `{ limit, windowSeconds }` |
| `idempotent?` | Enable `Idempotency-Key` handling |
| `allowDuringMfaEnrollment?` | Allow while the org requires MFA and the user has not enrolled |
| `status?` | Success status override |
| `handler(args)` | `{ req, platform, params, body, query, meta, ctx, session?, cookies, setCookie }` |

### Adding an API route

```ts
// apps/web/src/app/api/v1/widgets/[id]/route.ts
import { z } from "zod";
import { route } from "@/lib/api";

export const PATCH = route({
  auth: "any",
  permission: "connector.manage",
  body: z.object({ name: z.string().min(1).max(120) }),
  handler: ({ platform, ctx, params, body }) => platform.connectors.update(ctx, params.id!, body),
});
```

Keep handlers thin: authorization, auditing and validation live in the service. Dynamic params arrive as strings (catch-all arrays are joined with `/`).

## Calling services from Server Components

```tsx
import { requireViewer, can } from "@/lib/viewer";
import { getPlatform } from "@/lib/platform";

export default async function ConnectorsPage() {
  const viewer = await requireViewer();                 // redirects to /login when signed out
  const platform = await getPlatform();
  if (!can(viewer, "connector.read")) return <Forbidden />;   // UI affordance only
  const connectors = await platform.connectors.list(viewer.ctx); // enforced server-side
  …
}
```

`getViewer()` (request-cached with React `cache`) resolves the session cookie via `auth.resolve`, and returns `{ user, ctx, organization, organizations, permissions, navigation, mfaEnrollmentRequired }`, or `null` when there is no session or no active org. `viewer.permissions` and `can()` are for hiding UI; the service call with `viewer.ctx` is the real check.

## Client-side calls

```ts
"use client";
import { apiFetch, ApiError } from "@/lib/client";

const conn = await apiFetch<{ id: string }>("/connectors", {
  body: { type: "rest_api", name: "CRM", authType: "api_key", config: { baseUrl: "https://crm.example.com" } },
  idempotencyKey: crypto.randomUUID(),
});
```

`apiFetch(path, { method?, body?, idempotencyKey? })` prefixes `/api/v1`, defaults to `POST` when a body is given, sends JSON, adds `x-csrf-token` from the `eaop_csrf` cookie on non-GET requests, unwraps `data`, throws `ApiError(status, code, message, details, requestId)` on errors, and redirects to `/login` on `401 UNAUTHENTICATED` outside `/auth/*`.

## Extension recipes

| Add | How |
|---|---|
| **Permission** | Core: append to `CORE_PERMISSIONS` (`packages/rbac/src/permissions.ts`) and grant it in `SYSTEM_ROLES` as appropriate. Module: `manifest.permissions` (+ `roleGrants`). Restart → `bootstrap()` syncs `permissions`/`role_permissions` |
| **Event** | Core: add a contract to `CORE_EVENTS` (`packages/events/src/core-events.ts`). Module: `manifest.events` with `owner` = module id. Publish with `platform.events.bus.publish(ctx, type, payload)`; subscribe with `bus.subscribe(type, "<unique stable name>", handler)` — handlers must be idempotent. Set `externallyVisible: false` to keep it off tenant webhooks |
| **Notification type** | Core: `CORE_NOTIFICATION_TYPES`; module: `manifest.notificationTypes`. Send with `platform.notifications.notify(ctx, { type, title, body?, actionUrl?: "/relative", recipients: { userIds?, roleKeys?, permission?, allMembers? } })` |
| **Search provider** | Core: `search.register({...})` in `createPlatform`; module: `manifest.searchProviders`. Implement `search(ctx, q, limit)` with `withTenant`, return relative `url`s and a 0..1 `score` (`textScore` helper); finish within 2 s |
| **Policy kind / operator** | `manifest.policyKinds` (`{ key, description, attributes, template? }`); evaluate with `platform.policies.evaluateKind(ctx, kind, input)`. Operators: `platform.policyEngine.registerOperator("ns.op", fn)` |
| **Job type** | `platform.jobs.register({ type: "<ns>.<name>", maxAttempts?, timeoutMs?, handle })` in the process that runs jobs (the worker builds the same platform, so register in code that both web and worker execute), enqueue with an `idempotencyKey` where duplicates matter |
| **Connector adapter** | See [CONNECTORS.md](CONNECTORS.md#adding-an-adapter) |
| **AI routing policy / hook** | `platform.ai.registerRoutingPolicy(name, fn)`, `platform.ai.registerPolicyHook(name, fn)` |
| **Actor type** | `platform.rbac.authorizer.registerActorResolver("agent", resolver)` |

## ESLint guardrails (`eslint.config.mjs`)

| Rule | Scope |
|---|---|
| `no-restricted-imports`: `openai`, `@anthropic-ai/sdk` → "Use @eaop/ai" | All `*.ts(x)` except `packages/ai/src/providers/**` |
| `no-restricted-imports`: `pg` → "Modules must use @eaop/db tenant-scoped access (withTenant)" (plus the provider SDKs) | `modules/**` |
| `no-console` (allow `warn`, `error`) | All, except `**/scripts/**` and `apps/worker/**` |
| `@typescript-eslint/consistent-type-imports` (inline) | All |
| `@typescript-eslint/no-unused-vars` (ignore `_`-prefixed) | All |
| `react-hooks/rules-of-hooks` (error), `exhaustive-deps` (warn) | All |

## Environment for local commands

Scripts read `process.env` directly; export your `.env` first (`set -a; . ./.env; set +a`). `APP_SECRET` must be set (≥ 32 chars) even though `.env.example` omits it. Next.js (`pnpm dev`) inherits the shell environment.

## Common pitfalls

- **Using `withSystem` to read tenant data** on a user's behalf bypasses RLS. Use `withTenant(scopeOf(ctx))`.
- **New table without `eaop_enable_tenant_rls`**: the runtime role has no grants (queries fail) and the release-blocker test fails.
- **Nested scopes**: a nested `withTenant` for a *different* org (or `withSystem` inside `withTenant`) opens a second connection and transaction; it does not see uncommitted outer writes, and holding row locks in the outer transaction can deadlock. Keep cross-scope work outside.
- **Audit/log key names**: keys matching `password|secret|token|api_key|authorization|cookie|credential|private_key|session|otp|mfa_code` are redacted — `sessionId` in metadata is stored as `[REDACTED]`.
- **Unregistered event types or notification types** throw `INTERNAL` at publish/notify time; register them first.
- **`ctx` on `public` / `session_any` routes** is typed `TenantContext` but may be `undefined`.
- **API keys on `session` routes** fail with `401` — use `auth: "any"` for machine-accessible endpoints.
- **`APPROVAL_REQUIRED`** is thrown as an error with HTTP 202; clients must treat it as "not executed".
- **Per-route `rateLimit` on authenticated routes** uses the same bucket key (`api:<org>:<actor>`) as every other route, so it is not an independent per-route budget; public routes are keyed per path.
- **POST returns 201** unless you set `status`.
- **drizzle-kit naming**: the next generated migration will start with `0001_`; rename it (see [DATABASE.md](DATABASE.md#changing-the-core-schema)).
- **Module migrations in tests**: not applied by `tests/helpers/global-setup.ts` yet.
- **Effective permissions are memoized per `ctx.cache`**: reuse one `ctx` per request, but do not reuse a `ctx` across requests (and create a new `cache: new Map()` for system contexts you build).
