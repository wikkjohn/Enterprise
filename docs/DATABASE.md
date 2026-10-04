# Database

PostgreSQL 16. Schema in Drizzle (`packages/db/src/schema/*.ts`), DDL in SQL migrations (`packages/db/migrations/`). Tenant isolation is enforced by **Row-Level Security** for a non-superuser runtime role.

## Roles

| Role | Created by | Used for | Requirements |
|---|---|---|---|
| Owner / admin (e.g. `eaop`) | You | `DATABASE_ADMIN_URL`: `pnpm db:migrate`, `pnpm db:reset`, tests' global setup | Owns all tables. Must be able to `CREATE ROLE` (migration 0001 creates `eaop_runtime`) and to `GRANT eaop_runtime` (superuser locally; `CREATEROLE` elsewhere) |
| `eaop_runtime` | Migration `0001_tenant_isolation_and_security.sql` | Group role (`NOLOGIN`) holding all table grants | — |
| Runtime login (e.g. `eaop_app`) | You | `DATABASE_URL`: web, worker, seed, scripts | `NOSUPERUSER NOBYPASSRLS`, then `GRANT eaop_runtime TO <role>` after migrating |

If the runtime role is a superuser or has `BYPASSRLS`, isolation is silently disabled; the release-blocker test asserts it is neither.

## Tables

Tenancy classes:
- **Tenant-owned** — `organization_id NOT NULL`; policy `tenant_isolation` (`eaop_enable_tenant_rls`).
- **Shared catalog** — `organization_id NULL` = platform row readable by every tenant, writable only in system scope; tenant rows isolated (`eaop_enable_shared_catalog_rls`).
- **Platform** — global catalogs readable by all, writable in system scope.
- **User-scoped** — visible to the owning user (or system).
- **Tenant/system ops** — tenants may insert and read their own rows; update/delete only in system scope.

### Tenancy & modules (`schema/tenancy.ts`)

| Table | Purpose | Class |
|---|---|---|
| `organizations` | Tenants: `name`, unique `slug`, `status` (`pending/active/suspended/archived`), `environment` (`production/staging/sandbox`), `primary_domain`, `plan` (informational) | Custom: readable by system, the current org, or orgs where the current user has an active membership; insert/delete system only |
| `organization_settings` | One row per org: `security`, `data_retention`, `usage_limits` (jsonb), `locale`, `timezone` | Tenant-owned |
| `organization_domains` | Claimed domains + DNS TXT `verification_token`, `verified_at`; `domain` globally unique | Tenant-owned |
| `modules` | Module catalog synced from manifests | Platform |
| `organization_modules` | Entitlement per org/module: `enabled`, `enabled_at`, `enabled_by`, `config` | Tenant-owned |
| `feature_flags` | `key`, `organization_id` (NULL = platform default), `module_id`, `enabled`, `rollout_percent`; unique `(key, organization_id)` NULLS NOT DISTINCT | Shared catalog |

### Identity (`schema/identity.ts`)

| Table | Purpose | Class |
|---|---|---|
| `users` | Global identity: case-insensitive unique `email`, `password_hash` (scrypt), `status`, `is_platform_admin`, `mfa_enabled`, `mfa_secret_ref`, `failed_login_count`, `locked_until`, `last_login_at` | Custom: readable by self, by system, or within an org the user belongs to; updatable by self or system; insert/delete system only |
| `sessions` | `token_hash` (SHA-256), `active_organization_id`, `auth_method`, `mfa_pending`, `mfa_verified_at`, `ip`, `user_agent`, `last_seen_at`, `expires_at`, `revoked_at`, `revoked_reason` | User-scoped (`owner_only`) |
| `auth_tokens` | One-time tokens (`password_reset`, `email_verification`), hash only, `expires_at`, `used_at` | User-scoped |
| `memberships` | User ↔ org: `status` (`invited/active/suspended/removed`), `title`, `department`, `source` (`manual/invitation/sso_jit/scim`) | Custom: tenant rows plus the user's own memberships (read) |
| `invitations` | `email`, `role_keys[]`, `token_hash`, `invited_by`, `expires_at`, `accepted_at`, `revoked_at` | Tenant-owned |
| `identity_providers` | SSO config: `protocol` (`oidc/saml`), `status`, `config` (non-secret), `client_secret_ref`, `domains[]`, `jit_provisioning`, `default_role_key` | Tenant-owned |

### RBAC (`schema/rbac.ts`)

| Table | Purpose | Class |
|---|---|---|
| `permissions` | Permission catalog (`key`, `owner`, `description`, `risk`) synced at boot | Platform |
| `roles` | System roles (`organization_id NULL`, `is_system`) and custom tenant roles | Shared catalog |
| `role_permissions` | Role → permission key | Custom: follows the role's ownership |
| `member_roles` | Membership → role, optional `scope_type` (`module`/`resource`) + `scope_id`, `granted_by` | Tenant-owned |

### Integration & AI (`schema/integration.ts`)

| Table | Purpose | Class |
|---|---|---|
| `connectors` | Tenant connector instances: `type`, `name` (unique per org), `status`, `auth_type`, `config` (non-secret), `scopes`, `health_status`, `last_error`, `rate_limit` | Tenant-owned |
| `connector_capabilities` | Enabled capabilities and operations per connector | Tenant-owned |
| `connector_credentials_metadata` | Credential metadata: `kind`, `secret_ref`, `scopes`, `status`, `expires_at`, `last_rotated_at`, `rotation_interval_days`, `owner_user_id`, `hint` | Tenant-owned |
| `ai_providers` | Platform (`organization_id NULL`) and tenant BYO providers: `key`, `kind`, `status`, `config`, `credential_secret_ref` | Shared catalog |
| `ai_models` | Models per provider: `model_key`, `capabilities`, `context_window`, `max_output_tokens`, `input/output_cost_per_mtok`, `tier`, `max_data_classification`, `status` | Shared catalog |
| `ai_runs` | One row per AI execution: provider/model, module, use case, actor, status, tokens, latency, `estimated_cost_usd`, retention mode, prompt hash/sizes, optional request/response (only `full`), policy decision/reasons, error, `metadata` | Tenant-owned |
| `api_keys_metadata` | `name`, unique `prefix`, `key_hash`, `scopes`, `last_used_at`, `expires_at`, `revoked_at` | Tenant-owned |
| `webhooks` | Tenant outbound webhooks: `url`, `event_types`, `signing_secret_ref`, `status`, `consecutive_failures`, last delivery | Tenant-owned |
| `usage_events` | Metered usage with dimensions; unique `(organization_id, dedupe_key)` | Tenant-owned |
| `event_outbox` | Transactional outbox (`status`: `pending/dispatching/dispatched/failed/dead`) | Tenant/system ops |
| `background_jobs_metadata` | Job queue (`status`: `queued/running/succeeded/failed/dead/cancelled`); unique `(type, idempotency_key)` | Tenant/system ops |

### Governance (`schema/governance.ts`)

| Table | Purpose | Class |
|---|---|---|
| `policies` | Policy header: `key` (unique per org), `owner`, `kind`, `status`, `active_version` | Tenant-owned |
| `policy_versions` | Immutable versions: `version`, `definition` jsonb, `change_note`, `created_by` | Tenant-owned |
| `audit_events` | Append-only audit log ([AUDIT.md](AUDIT.md)); `organization_id` NULL only for platform-level events; FK `ON DELETE RESTRICT` | Custom: select/insert only |
| `notifications` | Per-recipient in-app notifications | Tenant-owned |
| `notification_preferences` | `(organization_id, user_id, type, channel)` → `on/off` | Tenant-owned |
| `platform_errors` | Redacted operational errors for the health page | Tenant/system ops |
| `idempotency_keys` | `(organization_id, key)` → request hash + stored response, `expires_at` | Tenant-owned |
| `dev_secret_values` | Local secret store ciphertext (`ref`, `iv`, `auth_tag`, `destroyed_at`) | Tenant/system ops |

Plus `schema_migrations(owner, name, applied_at)`, created by the migration runner (runtime role has `SELECT`).

## Row-Level Security design

### GUCs and helper functions (migration 0001)

| GUC | Helper | Set when |
|---|---|---|
| `app.current_org_id` | `eaop_current_org()` → uuid or NULL | Tenant scope |
| `app.current_user_id` | `eaop_current_user()` → uuid or NULL | Tenant scope with a user actor, or user scope |
| `app.system_context` | `eaop_is_system()` → `= 'on'` | System scope |

Policy helpers: `eaop_enable_tenant_rls(regclass)` (ENABLE + FORCE RLS, policy `tenant_isolation USING/WITH CHECK (eaop_is_system() OR organization_id = eaop_current_org())`, grants to `eaop_runtime`) and `eaop_enable_shared_catalog_rls(regclass)` (`catalog_read` also allows `organization_id IS NULL`; `catalog_write` does not).

All policies use `FORCE ROW LEVEL SECURITY`, so they apply to the table owner as well. With no GUCs set (a bare connection as the runtime role) every tenant table returns zero rows.

### Scopes in code (`packages/db/src/client.ts`)

```ts
await db.withTenant(scopeOf(ctx), (tx) => tx.select().from(connectors));   // one tenant
await db.withUser(userId, (tx) => ...);                                      // own memberships/sessions, no tenant
await db.withSystem("jobs.claim", (tx) => ...);                              // bypasses tenant RLS; reason required
```

Each call opens a transaction and first runs:

```sql
select set_config('app.current_org_id', $org, true),
       set_config('app.current_user_id', $user, true),
       set_config('app.system_context', $system, true)
```

`is_local = true` makes the settings transaction-local, so they can never leak to another request on a pooled connection (asserted by "tenant scope GUCs are transaction-local and never leak across pooled connections").

- **Re-entrancy (ALS transaction reuse).** The active transaction and its scope are kept in `AsyncLocalStorage`. A nested `withTenant` / `withUser` / `withSystem` with the *same* scope runs on the outer `tx`; a *different* scope opens its own connection and transaction. This is why `audit.record` and `bus.publish` inside a service's `withTenant` are atomic with the business write.
- **`afterCommit(fn)`** queues `fn` until the outermost transaction commits (immediately when called outside one). Errors go to `onAfterCommitError` (logged as `db.after_commit_failed`).
- **`lockKey(name)`** hashes a name to an int for `pg_advisory_xact_lock` (used by `rbac.sync_catalog`).
- **`scopeOf(ctx)`** includes `userId` only for user actors with a UUID id.
- Tenant scope validates the organization id is a UUID before opening the transaction.

`withSystem` is for auth bootstrap, session lookup, org provisioning, workers, retention and cross-tenant uniqueness checks. Every call passes a `reason` string; it is greppable documentation of why RLS is bypassed and is not logged.

## Migrations

| Source | Location | History owner |
|---|---|---|
| Core | `packages/db/migrations/*.sql` (`CORE_MIGRATIONS_DIR`) | `core` |
| Modules | `modules/<name>/migrations/*.sql`, discovered by `packages/db/scripts/module-migrations.ts` | `module:<name>` |

Runner (`runMigrations` in `packages/db/src/migrate.ts`, invoked by `pnpm db:migrate` with `DATABASE_ADMIN_URL`):

1. `CREATE TABLE IF NOT EXISTS schema_migrations (owner, name, applied_at)`.
2. `pg_advisory_lock(727274)` — concurrent migrators serialize.
3. For each source (core first, then modules alphabetically), apply unapplied `*.sql` files in lexical order, each in its own transaction, recording `(owner, file)`. A failure rolls back that file and aborts with `Migration <owner>/<file> failed: ...`.

Current core migrations:

| File | Origin | Content |
|---|---|---|
| `0000_core_schema.sql` | Generated by drizzle-kit from `src/schema` | Tables, indexes, foreign keys |
| `0001_tenant_isolation_and_security.sql` | Hand-written | `eaop_runtime`, RLS helpers and policies, audit immutability, purge function, grants |

### Changing the core schema

1. Edit `packages/db/src/schema/*.ts`.
2. `pnpm --filter @eaop/db generate` (drizzle-kit; config in `packages/db/drizzle.config.ts`, output `packages/db/migrations`).
3. **Filenames**: `drizzle.config.ts` sets `migrations: { prefix: "timestamp" }`, so generated files get a timestamp prefix and sort after the hand-written `0000_`/`0001_` files. Review the generated SQL before committing.
4. For every new tenant-owned table add a hand-written SQL migration (or append to the generated one) calling `SELECT eaop_enable_tenant_rls('<table>');` — without it the runtime role has no grants on the table at all, and the release-blocker test fails if `organization_id` exists without forced RLS.
5. Never edit an applied migration; add a new one.

`pnpm db:reset` (`packages/db/scripts/reset.ts`) drops and recreates `public` (refuses when `APP_ENV=production`).

## Retention

`runRetention(platform)` (`packages/platform/src/maintenance.ts`) runs as the `maintenance.retention` job, scheduled by the worker every 24 h (first run 60 s after start). Per organization, using its `data_retention` settings:

| Data | Rule |
|---|---|
| `ai_runs` | delete `created_at` older than `aiRunDays` |
| `notifications` | older than `notificationDays` |
| `usage_events` | `occurred_at` older than `usageDays` |
| `idempotency_keys` | `expires_at` in the past |
| `audit_events` | via `eaop_purge_audit_events(org, now - max(90, auditDays) days)`; the function itself refuses cut-offs newer than 90 days |

Platform-wide: `platform_errors` older than 30 days; `event_outbox` rows `dispatched` and older than 14 days; jobs `succeeded`/`cancelled` older than 14 days. `dead`/`failed` jobs and outbox rows are kept.
