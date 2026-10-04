# Audit Log

Code: `packages/audit/src/index.ts`; table `audit_events` (`packages/db/src/schema/governance.ts`); immutability in `packages/db/migrations/0001_tenant_isolation_and_security.sql`.

## Schema (`audit_events`)

| Column | Content |
|---|---|
| `id` | uuid |
| `organization_id` | Tenant; NULL only for platform-level events (e.g. failed login for an unknown email). FK `ON DELETE RESTRICT` — an organization with audit history cannot be hard-deleted |
| `occurred_at` | timestamptz(3), default `now()` |
| `actor_type`, `actor_id`, `actor_label` | From `ctx.actor` (`user` + email, `api_key` + `api_key:<name>`, `system` + `system:<component>`, `anonymous` for unknown logins) |
| `module` | `core` or a module id |
| `action` | e.g. `connector.created`, `rbac.permission_denied` |
| `resource_type`, `resource_id` | Optional subject |
| `outcome` | `success` / `failure` / `denied` |
| `before`, `after` | Redacted JSON snapshots |
| `metadata` | Redacted JSON |
| `ip`, `user_agent` (≤ 512 chars), `correlation_id` | Request context (`correlation_id` = `x-request-id`) |

Indexes: `(organization_id, occurred_at)`, `(organization_id, action)`, `(organization_id, resource_type, resource_id)`.

## Append-only enforcement

| Layer | Mechanism |
|---|---|
| Privileges | `GRANT SELECT, INSERT ON audit_events TO eaop_runtime; REVOKE UPDATE, DELETE, TRUNCATE ... FROM eaop_runtime` |
| RLS | `audit_read` and `audit_insert` policies only (tenant or system scope); no update/delete policies |
| Trigger | `audit_events_no_update` (BEFORE UPDATE OR DELETE, per row) and `audit_events_no_truncate` (BEFORE TRUNCATE) call `eaop_audit_immutable()`, which raises `audit_events is append-only (<op> blocked)` with SQLSTATE `insufficient_privilege` — this also blocks the table owner |
| Only deletion path | `eaop_purge_audit_events(p_org uuid, p_before timestamptz)` — `SECURITY DEFINER` (runs as owner), raises `audit retention floor is 90 days` if `p_before > now() - 90 days`, sets the transaction-local `app.audit_retention_purge = 'on'` that the trigger accepts only for `DELETE` by the table owner, deletes that org's rows older than `p_before`, returns the count. `EXECUTE` granted to `eaop_runtime` only |

Tests: "is append-only for the runtime role, even with system scope", "retention purge refuses to delete anything newer than 90 days".

## Recording API

```ts
await platform.audit.record(ctx, {
  module: "workflow_intelligence",          // default "core"
  action: "workflow.approved",
  resourceType: "workflow", resourceId: id,
  outcome: "success",                       // default
  before: { status: "draft" }, after: { status: "approved" },
  metadata: { note },
});
```

| Method | Transaction behaviour | Use for |
|---|---|---|
| `record(ctx, input)` | `withTenant(scopeOf(ctx))` — **joins the caller's transaction** when one is active for the same scope, so the audit row commits or rolls back with the change | Every successful state change |
| `recordDetached(ctx, input)` | Scheduled with `setImmediate` in a fresh async context and its own transaction; never joins the caller's transaction; failures are logged (`audit.record_detached_failed`), not thrown | Denials and failures that must survive a rollback (`rbac.permission_denied`, login failures) |
| `recordPlatform(meta, input)` | `withSystem`, `organization_id = NULL` | Events without a tenant (unknown-user login failure, logins of users with no org) |
| `query(ctx, q)` | Tenant-scoped read; caller must have checked `audit.read` | Admin UI / API |

## What is captured (`AuditActions`)

| Area | Actions |
|---|---|
| Authentication | `auth.login`, `auth.login_failed`, `auth.logout`, `auth.mfa_enrolled`, `auth.mfa_disabled`, `auth.password_changed`, `auth.password_reset_requested`, `auth.session_revoked`, `auth.organization_switched` |
| Organization | `organization.created`, `organization.updated`, `organization.status_changed`, `organization.settings_changed`, `organization.domain_added`, `organization.domain_verified` |
| Users | `user.invited`, `user.invitation_accepted`, `user.invitation_revoked`, `user.suspended`, `user.reactivated`, `user.removed` |
| RBAC | `rbac.role_created`, `rbac.role_updated`, `rbac.role_deleted`, `rbac.role_assigned`, `rbac.role_revoked`, `rbac.permission_denied` |
| Modules | `module.enabled`, `module.disabled`, `module.feature_flag_changed` |
| Connectors | `connector.created`, `connector.updated`, `connector.deleted`, `connector.tested`, `connector.credential_set`, `connector.credential_rotated`, `connector.credential_revoked` |
| AI | `ai.provider_changed`, `ai.model_changed` |
| Policies | `policy.created`, `policy.versioned`, `policy.activated`, `policy.disabled` |
| API keys | `api_key.created`, `api_key.revoked` |
| Webhooks | `webhook.created`, `webhook.deleted` (resource type `webhook`; `after` holds the URL and event types on create, the URL on delete) |
| SSO | `sso.identity_provider_changed` |
| Data | `data.exported` |
| Defined but not yet emitted | `admin.action` |

Additional literal actions emitted by services: `connector.action_executed` (connector `write`/`delete`/`execute` operations, with capability, operation, attempts, latency) and `ai.run_blocked` (`outcome: denied`, decision and reasons). Login events include `method` (`password`, `password+totp`, `oidc`) and `sessionId` in metadata; failures include a `reason` (`bad_password`, `locked`, `ip_not_allowed`, `bad_mfa_code`, `sso_not_member`, `unknown_user_or_sso_only`, `user_<status>`).

Modules add their own namespaced actions (e.g. `workflow.approved`) with `module` set to their id.

## Redaction

`before`, `after` and `metadata` pass through `redact()` (`packages/observability/src/redact.ts`): values under keys matching `pass(word)?|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key|session[-_]?token|otp|mfa[-_]?code` become `[REDACTED]`; string values matching provider keys (`sk-…`), platform API keys (`eaop_…_…`), `Bearer …`, AWS access key ids and PEM private keys are masked; depth is capped at 8 and arrays at 100 items. Callers should still avoid putting secrets in audit inputs. Identifiers such as `sessionId` are kept; `sessionToken` / `session_token` (and anything matching `token`) are redacted.

## Query API and export

`GET /api/v1/audit` (`audit.read`, session or API key). Query parameters (`auditQuerySchema`):

| Param | Filter |
|---|---|
| `action`, `module`, `actorId`, `resourceType`, `resourceId` | Exact match |
| `outcome` | `success` / `failure` / `denied` |
| `from`, `to` | `occurred_at` range (any `Date`-parseable value) |
| `q` | Case-insensitive substring over `action`, `actor_label`, `resource_id` (LIKE wildcards escaped) |
| `limit` | 1 – 500, default 50 |
| `cursor` | Keyset cursor `(occurred_at, id)` from the previous page's `nextCursor` |

Results are ordered newest first; response `{ data: { data: [...], nextCursor } }`.

`GET /api/v1/audit/export` (`audit.export`, 10 requests / 5 min) streams a CSV of up to ~50,000 rows (pages of 500) with columns `occurredAt, actorType, actorId, actorLabel, module, action, resourceType, resourceId, outcome, ip, userAgent, correlationId, before, after, metadata`. Every cell is quoted; cells beginning with `=`, `+`, `-`, `@`, tab or carriage return are prefixed with `'` to neutralize spreadsheet formula injection. Each export is itself audited as `data.exported` with the row count and filters.

## Retention

Per-organization `dataRetention.auditDays` (default 2555 ≈ 7 years, allowed 90 – 3650). The daily `maintenance.retention` job calls `eaop_purge_audit_events(org, now - max(90, auditDays) days)`. No other code path can delete audit rows.
