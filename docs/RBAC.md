# Role-Based Access Control

Code: `packages/rbac/src` (`permissions.ts`, `roles.ts`, `authorizer.ts`, `role-service.ts`). Tables: `permissions`, `roles`, `role_permissions`, `member_roles` ([DATABASE.md](DATABASE.md#rbac-schemarbacts)).

## Permission naming

`<namespace>[.<sub>].<verb>`, lowercase with underscores, at least two segments — `PERMISSION_KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/`. Each key has exactly one owner (`core` or a module id); registering a key already owned by someone else throws. Modules may not use the `platform`, `org` or `role` namespaces. Role definitions use patterns: `*` (all registered), `ns.*` (prefix), exact keys, and `!key` / `!ns.*` exclusions; unknown exact keys throw at expansion.

## Core permissions (`CORE_PERMISSIONS`)

| Key | Risk | Description |
|---|---|---|
| `platform.admin` | critical | Administer the platform: provision organizations, manage the module catalog |
| `org.read` | low | View organization profile |
| `org.manage` | high | Change organization profile, domains and settings |
| `org.security.read` | medium | View security settings and SSO configuration |
| `org.security.manage` | critical | Change security policy, SSO and MFA requirements |
| `user.read` | low | View organization members |
| `user.invite` | medium | Invite users to the organization |
| `user.manage` | high | Suspend, reactivate and remove members |
| `role.read` | low | View roles and assignments |
| `role.manage` | critical | Create custom roles and assign/revoke roles |
| `module.read` | low | View enabled modules |
| `module.manage` | high | Enable/disable modules and feature flags |
| `connector.read` | low | View connectors and their health |
| `connector.use` | medium | Execute connector capabilities |
| `connector.manage` | high | Create, update and delete connectors |
| `connector.credential.manage` | critical | Set, rotate and revoke connector credentials |
| `ai.use` | medium | Run AI requests through the shared AI layer |
| `ai.run.read` | medium | View AI run logs |
| `ai.provider.read` | low | View AI providers and models |
| `ai.provider.manage` | high | Configure AI providers, models and routing |
| `policy.read` | low | View policies |
| `policy.manage` | high | Create, version and activate policies |
| `audit.read` | medium | Query the audit log |
| `audit.export` | high | Export the audit log |
| `notification.manage` | medium | Manage organization notification settings and webhooks |
| `usage.read` | low | View usage metering |
| `observability.read` | medium | View the operational health dashboard |
| `apikey.read` | low | View API keys (metadata only) |
| `apikey.manage` | critical | Create and revoke API keys |
| `search.use` | low | Use global search |

`GET /api/v1/permissions` (`role.read`) lists all registered permissions, including module ones.

## System roles (`SYSTEM_ROLES`)

Shared by every tenant (`roles.organization_id IS NULL`, `is_system = true`), defined in code and re-synced by `bootstrap()`; they cannot be edited or deleted through the API.

| Key | Name | Permission patterns |
|---|---|---|
| `platform_admin` | Platform Administrator | `platform.admin` — `platformOnly`, never assignable in a tenant, hidden from role lists |
| `org_admin` | Organization Administrator | `*`, `!platform.admin` (includes every module permission) |
| `security_admin` | Security Administrator | `org.read`, `org.security.*`, `user.read`, `user.manage`, `role.read`, `module.read`, `connector.read`, `connector.credential.manage`, `policy.*`, `audit.*`, `apikey.*`, `observability.read`, `notification.manage`, `ai.run.read`, `ai.provider.read`, `usage.read`, `search.use` |
| `ai_admin` | AI Administrator | `org.read`, `module.read`, `ai.*`, `connector.read`, `connector.use`, `policy.read`, `usage.read`, `observability.read`, `search.use` |
| `auditor` | Auditor | `org.read`, `org.security.read`, `user.read`, `role.read`, `module.read`, `connector.read`, `ai.run.read`, `ai.provider.read`, `policy.read`, `audit.read`, `audit.export`, `usage.read`, `apikey.read`, `search.use` |
| `executive` | Executive | `org.read`, `module.read`, `usage.read`, `search.use` |
| `department_leader` | Department Leader | `org.read`, `user.read`, `module.read`, `usage.read`, `ai.use`, `search.use` |
| `analyst` | Analyst | `org.read`, `module.read`, `ai.use`, `connector.read`, `connector.use`, `usage.read`, `search.use` |
| `standard_user` | Standard User | `org.read`, `module.read`, `ai.use`, `search.use` |
| `read_only` | Read Only | `org.read`, `module.read`, `search.use` |

Modules add permissions to system roles with `manifest.roleGrants` (e.g. `{ analyst: ["workflow.read"] }`); `syncCatalog` expands `[...def.permissions, ...roleGrants[key]]` and rewrites `role_permissions` for each system role under an advisory lock.

Custom roles: `POST /api/v1/roles` (`role.manage`) with `{ key, name, description?, permissions }`. Keys match `^[a-z][a-z0-9_]{1,62}$` and may not reuse a system key. `PUT /api/v1/roles/:key { permissions }`, `DELETE /api/v1/roles/:key`.

## Authorization decision (`authorizer.require` / `can`)

`decide(ctx, permission, resource?)`:

1. Unknown permission → `FORBIDDEN`.
2. `platform.admin` → allowed only if `ctx.actor.isPlatformAdmin` (the `users.is_platform_admin` flag); never via roles.
3. Load effective permissions (memoized in `ctx.cache` per request) inside `withTenant`: organization status plus grants.
4. Organization not `active` → `ORGANIZATION_SUSPENDED`.
5. Permission owned by a module that is not enabled for the tenant → `MODULE_NOT_ENABLED`.
6. Org-wide grant → allow. Scoped grant → allow if `scope_type = module` and `scope_id` = the permission's owner, or `scope_type = resource` and `scope_id = "<resource.type>:<resource.id>"` matches the `resource` argument.
7. Otherwise `FORBIDDEN`.

`require` throws the matching `AppError` (`details: { permission }`) and records `rbac.permission_denied` with `outcome: "denied"` via `audit.recordDetached` (survives the caller's rollback). `authorizer.list(ctx)` returns held org-wide keys (plus `platform.admin` for platform admins) minus those of disabled modules — **for UI hints only**.

### Scoped grants

`POST /api/v1/role-assignments { membershipId, roleKey, scopeType?, scopeId? }` (`role.manage`). `scopeType` and `scopeId` must be given together.

| Scope | `scope_id` | Effect |
|---|---|---|
| none | — | Role's permissions apply organization-wide |
| `module` | module id, e.g. `workflow_intelligence` | Only the role's permissions **owned by that module** apply |
| `resource` | `<type>:<id>`, e.g. `connector:3f1c…` | Only applies when the service passes that `resource` (connector services pass `{ type: "connector", id }` for get/update/delete/test/execute/credentials) |

Scoped grants are not considered for notification recipients (`recipients.permission` uses org-wide grants only) or for anti-escalation (only org-wide holdings count as "held").

## Actor types

| `Actor.type` | Permissions come from |
|---|---|
| `user` | Active membership's `member_roles` → `role_permissions` |
| `api_key` | `actor.scopes` that are registered permissions |
| `system` | Every registered permission except `platform.admin` (still subject to org status and module entitlement) |
| `agent` or any other type | A resolver registered with `authorizer.registerActorResolver(type, resolver)`; **no resolver → no permissions** |

Extension point for Agent Governance:

```ts
platform.rbac.authorizer.registerActorResolver("agent", async (ctx) => {
  // look up the agent's approved grants in the module's tables (withTenant)
  return { orgWide: ["connector.use"], scoped: [{ permission: "connector.use", scopeType: "resource", scopeId: "connector:<id>" }] };
});
```

The built-in types `user`, `system`, `api_key` cannot be overridden.

## Safeguards

| Safeguard | Implementation |
|---|---|
| **Anti-escalation** | `createRole`, `updateRolePermissions` and `assign` require the actor to hold (org-wide) every permission being granted; `invite` requires the inviter to hold every permission of every invited role; API key scopes must be held by the creator. System actors are exempt |
| **`platform.admin` never in tenants** | Rejected in custom roles; `platform_admin` role cannot be assigned (`NOT_FOUND`) or listed; `org_admin` excludes it |
| **Non-delegable API key scopes** | `platform.admin`, `apikey.manage`, `role.manage` |
| **Separation of duties** (`SOD_CONSTRAINTS`) | A member may not hold `auditor` together with `org_admin`, or `auditor` together with `security_admin` → `CONFLICT` "Separation of duties: …" |
| **Last-admin protection** | Revoking an org-wide `org_admin` assignment is refused when it is the last one held by an active member (`CONFLICT` "An organization must keep at least one administrator."), and suspending/removing the last active org-wide `org_admin` membership is refused (`CONFLICT` "An organization must keep at least one active administrator.") |
| **Self-change prevention** | Users cannot assign or revoke their own roles, nor change their own membership status → `FORBIDDEN` |
| **System roles immutable** | Edit/delete → `FORBIDDEN` |
| **Immediate effect** | Effective permissions are read per request (only memoized within one request); suspension/removal applies on the next request |
| **Suspended organizations** | Every permission check returns `ORGANIZATION_SUSPENDED`; API keys of non-active orgs stop authenticating |

Known gap: SoD constraints are checked on `assign`, not on custom role definition edits.

## Platform admin vs tenant data

`users.is_platform_admin` grants `platform.admin` only: provisioning and listing organizations (`/api/v1/platform/organizations`), changing org status, and the Prometheus endpoint. It grants **no** tenant permissions; a platform admin sees tenant data only through an ordinary membership with roles. Note that `POST /api/v1/platform/organizations` defaults `adminUserId` to the calling platform admin, which makes them that org's `org_admin` — pass a different `adminUserId` to avoid it. A platform admin who also holds `observability.read` in an org sees platform-wide queue stats and errors on `GET /api/v1/admin/health`.

## How modules register permissions

```ts
// modules/<name>/src/index.ts
permissions: [{ key: "workflow.approve", description: "Approve opportunities.", risk: "high" }],
roleGrants: { department_leader: ["workflow.approve"], analyst: ["workflow.read", "workflow.analyze"] },
```

Module permissions are inert until the module is installed **and** enabled for the tenant. Tenant admins can include them in custom roles or assign roles scoped to the module (`scopeType: "module", scopeId: "workflow_intelligence"`).
