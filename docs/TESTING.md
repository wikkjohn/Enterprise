# Testing

Vitest 3 with two projects (`vitest.config.ts`):

| Project | Files | Environment |
|---|---|---|
| `unit` | `tests/unit/**/*.test.ts`, `packages/**/*.test.ts` | No database |
| `integration` | `tests/integration/**/*.test.ts` | Real PostgreSQL; `globalSetup: tests/helpers/global-setup.ts`; all files run serially in a single fork (shared DB and global system-role catalog); 30 s test / 60 s hook timeout |

There are **17 test files with 160 test cases** (11 integration files, 6 unit files; the connector contract test generates one case per catalog definition), all passing at the time of writing.

## Running

```bash
pnpm test                 # both projects
pnpm test:unit            # vitest run --project unit
pnpm test:integration     # vitest run --project integration
pnpm check                # typecheck + lint + test
```

### Database for integration tests

Connection strings (`tests/helpers/env.ts`):

| Variable | Default |
|---|---|
| `TEST_DATABASE_ADMIN_URL` | `postgres://eaop:eaop@localhost:5432/eaop_test` |
| `TEST_DATABASE_URL` | `postgres://eaop_app:eaop_app@localhost:5432/eaop_test` |
| `TEST_DATABASE_APP_ROLE` | `eaop_app` |

One-time setup (see the README for the full SQL): roles `eaop` (owner) and `eaop_app` (`NOSUPERUSER NOBYPASSRLS`) and database `eaop_test` owned by `eaop`. `global-setup.ts` then, on every run, **drops and recreates schema `public`** in the test database, applies the core migrations **and** every `modules/*/migrations` directory (`moduleMigrationSources()`), and runs `GRANT eaop_runtime TO eaop_app` (errors ignored). Never point the test URLs at a database you care about.

CI (`.github/workflows/platform-ci.yml`) uses a `postgres:16` service with `POSTGRES_DB=eaop_test`, creates `eaop_app`, then runs `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`.

### Helpers (`tests/helpers/platform.ts`)

| Helper | Purpose |
|---|---|
| `createTestPlatform(overrides?, envOverrides?)` | `createPlatform` with `TEST_ENV` (`APP_ENV=test`, fixed `APP_SECRET`/`LOCAL_SECRETS_KEY`, signup on), a `MemorySink` logger (`platform.logs`), stub DNS for TXT lookups and the URL guard (`resolve: → 93.184.216.34`), then `bootstrap()` |
| `createOrg(p, name?)` | New admin user + org (system actor); returns `{ org, admin, adminCtx() }` |
| `addMember(p, orgId, roleKeys, user?)` | Active membership with system roles; returns `{ user, membership, ctx() }` |
| `createUser`, `userCtx`, `systemCtx`, `meta`, `membershipOf`, `uniq` | Building blocks; all test users share `PASSWORD` |
| `expectCode(promise, code)` | Asserts an `AppError` code |

API conventions are tested by building routes with `createRouteFactory(() => p)` and calling them with standard `Request` objects (`tests/integration/api.test.ts`) — no Next.js server needed.

## Release blocker

> **`tests/integration/tenant-isolation.test.ts` must pass for every release.** A user from Organization A must never access Organization B's data.

It seeds org B with one of everything (sandbox connector with credentials, policy, API key, secret, notification, AI run) and checks two layers:

- **Database (RLS)**: every table with `organization_id` has RLS enabled **and forced**; the runtime role is not superuser and lacks BYPASSRLS; an unscoped runtime connection sees zero rows in tenant tables (including `organizations`); A's scope sees zero B rows in **every** table with `organization_id`; A's scope cannot insert into B (RLS error) nor update/delete B's rows by id; GUCs do not leak across pooled connections.
- **Services**: connectors (list/get/update/delete/test/execute/credentials) → `NOT_FOUND`; secrets (A cannot resolve B's reference); policies, API keys, audit, AI runs, notifications, usage, members stay within A; roles (cannot assign to B's memberships or see B's custom roles); search; session org switch into B indistinguishable from a non-existent org; API keys bound to their org; a member of both orgs sees only the active org's data.

## What each suite covers

| File | Covers |
|---|---|
| `tests/unit/security.test.ts` | scrypt hash/verify, password policy, TOTP RFC 6238 vector and ±1 window, token-bucket limiter, CSRF accept/reject, SSRF guard, CIDR allowlists, constant-time compare, security headers (CSP, frame denial, HSTS in production), log redaction |
| `tests/unit/shared.test.ts` | Cursor round-trip/tamper, `AppError`, correlation id sanitization, Prometheus output, system roles expand to registered permissions (org_admin excludes `platform.admin`), malformed/conflicting permission keys, the six module placeholders (unique ids/paths, namespaced permissions, all `not_installed`), modules cannot claim core namespaces, `isAppError` recognises errors from a duplicate module copy (and `errorResponse` maps them to their status) |
| `tests/unit/policy-engine.test.ts` | ALLOW/REQUIRE_APPROVAL/ESCALATE/DENY with explanations, action wildcards and nested `all`/`any`/`not`, first-match, default DENY, invalid definitions, namespaced custom operators, prototype-safe paths |
| `tests/unit/ai-router.test.ts` | Classification exclusion with reasons, tier → tenant-owned → cheapest ordering, explicit model + context window, cost estimation |
| `tests/unit/anthropic-adapter.test.ts` | Wire format: explicit effort, no sampling params, refusal fallback opt-in; omitted for Haiku 4.5 and when disabled; refusal mapping and served model; typed SDK error mapping; fails closed without credentials |
| `tests/unit/connectors.contract.test.ts` | `definitionViolations` for every definition, status → error class, `Retry-After` parsing, REST path confinement |
| `tests/integration/tenant-isolation.test.ts` | Release blocker (above) |
| `tests/integration/rbac.test.ts` | Least privilege per system role, auditor read-only, denials audited, module permissions gated by entitlement, module- and resource-scoped grants, anti-escalation, self-change prevention, SoD, last admin, immutable system roles, API key scopes, member suspension, suspended orgs |
| `tests/integration/auth-sessions.test.ts` | Login + token hash only, generic errors, lockout, logout, idle expiry, deactivated users, IP allowlist, TOTP enrollment and login, org-required MFA, invitations (accept, weak password, revoked, allowed domains), reset non-enumeration, org switching |
| `tests/integration/api.test.ts` | Error envelope + request id, CSRF on cookie mutations, 201/422, server-side 403, Bearer API keys without CSRF, idempotency replay/conflict, no internal leakage, `MODULE_NOT_ENABLED`, login-CSRF origin check, per-IP rate limit + `Retry-After` |
| `tests/integration/audit.test.ts` | Append-only even in system scope, 90-day purge floor, who/what/when/where + redaction, login/settings/module events, filters + keyset pagination |
| `tests/integration/connectors.test.ts` | Honest availability labels, contract-only cannot execute, no plaintext credentials, secrets in config rejected, rotate/revoke, REST auth header + path confinement + metering, transient retries with `Retry-After`, no retry on permanent + `connector.failed`, OAuth client-credentials refresh on 401, SSRF block, capability/operation gating, health check + notification |
| `tests/integration/events-jobs-notifications.test.ts` | Contract validation, after-commit single delivery, per-subscriber redelivery, job backoff + dead-letter, enqueue idempotency, recipient resolution/preferences/tenant boundary, mandatory types + relative URLs, signed webhook delivery + auto-disable |
| `tests/integration/modules.test.ts` | Six modules listed, placeholders cannot be enabled, navigation vs entitlements/permissions, dependencies both ways, `requireEnabled`, feature flag precedence + audit, enable/disable audit/events, placeholder health |
| `tests/integration/ai.test.ts` | Catalog seeding/routability, run logging + metering + `ai.run.completed`, retention modes, `ai_usage` DENY / REQUIRE_APPROVAL before any provider call, redaction hooks, refusals surfaced and logged, `ai.use` + classification routing, tenant BYO provider with secret-store credentials |
| `tests/integration/retention.test.ts` | Retention per tenant settings without touching recent audit history; only platform admins provision/list organizations |
| `tests/integration/review-fixes.test.ts` | Retention `none` keeps no hash/sizes; AI calls cannot be attributed to a module that is not enabled; the last active administrator cannot be suspended or removed; session ids kept but session tokens redacted in audit metadata; webhook create/delete audited; SSO enforcement on every request for the active org |

## Manual end-to-end verification

Besides the automated suites, the release that introduced the UI was verified manually (these scripts are **not committed**):

- a production `next build` + `next start`, walking all 21 UI pages with zero browser console errors;
- a Playwright flow: create a sandbox connector → set a credential → test it; create, activate and simulate a policy; invite a user and accept as a new user; a standard user receives 403 from `GET /api/v1/connectors`; the audit log shows all of these actions; ⌘K search; no horizontal overflow at 390 px width.

Repeat this walk-through before releases that change the UI; consider committing it as an automated e2e suite.

## Adding tests for a module

1. Build a test platform with the module installed: `createTestPlatform({ modules: [{ ...manifest, installStatus: "installed" }, ...otherManifests] })` (see `tests/integration/modules.test.ts`).
2. Put the module's SQL in `modules/<name>/migrations/`; `tests/helpers/global-setup.ts` applies it automatically after the core migrations.
3. Write `tests/integration/<module>.test.ts` for behaviour, permissions (`expectCode(..., "FORBIDDEN")`), entitlement (`"MODULE_NOT_ENABLED"` when disabled), audit records and events.
4. **Copy the isolation pattern**: create orgs A and B, enable the module in both, create B's resources, then assert from A's context that every service method returns `NOT_FOUND` / empty results and that a raw `withTenant({ organizationId: A })` count of B's rows in each new table is 0. The generic RLS assertions in `tenant-isolation.test.ts` will automatically include the new tables once their migrations are applied. See the example in [MODULE-SYSTEM.md](MODULE-SYSTEM.md#6-tests).
5. Stub outbound HTTP with `PlatformOverrides.fetchImpl` and DNS with `urlGuard: { resolve }`; use the sandbox AI provider (`model: "sandbox-echo"`, `__simulate_refusal__`, `__simulate_failure__`) and sandbox connector (`simulate.failure`) for deterministic AI/connector behaviour.
