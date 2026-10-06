# Module System

The platform is one shared core plus six modular applications. A module is a workspace package under `modules/<name>` that exports a `ModuleManifest`. The core installs manifests into its **shared** registries; modules never build their own auth, RBAC, audit, connectors, AI clients, notifications or database access.

## The six modules

**Installed:** AI Workflow Intelligence ([modules/WORKFLOW-INTELLIGENCE.md](modules/WORKFLOW-INTELLIGENCE.md)), Enterprise AI Integration ([modules/INTEGRATION.md](modules/INTEGRATION.md)), AI Agent Governance ([modules/AGENT-GOVERNANCE.md](modules/AGENT-GOVERNANCE.md)), AI Data Security ([modules/DATA-SECURITY.md](modules/DATA-SECURITY.md)), AI Knowledge & Verification ([modules/KNOWLEDGE-VERIFICATION.md](modules/KNOWLEDGE-VERIFICATION.md)) and AI Operations Management ([modules/AI-OPERATIONS.md](modules/AI-OPERATIONS.md)), all v1.0.0. The placeholder mechanism remains for future modules: a manifest with `installStatus: "not_installed"` reserves identity, route prefix, permission keys, navigation and event names; it appears in `GET /api/v1/modules` and navigation with `state: "not_installed"`, reports health `not_configured` ("Module not yet installed"), and `enable` returns `CONFLICT` ("… is not installed on this platform yet.").

| Id | Package dir | Name | `basePath` | Entry permission | Reserved permissions |
|---|---|---|---|---|---|
| `workflow_intelligence` | `modules/workflow-intelligence` | AI Workflow Intelligence | `/m/workflow-intelligence` | `workflow.read` | `workflow.{read,create,update,delete,analyze,approve}`, `workflow.roi.{read,manage}`, `workflow.implementation.manage` |
| `integration_hub` | `modules/integration-hub` | Enterprise AI Integration | `/m/integration-hub` | `integration.read` | `integration.{read,create,manage,execute,approve,admin}`, `integration.connector.use`, `integration.history.read` |
| `agent_governance` | `modules/agent-governance` | AI Agent Governance | `/m/agent-governance` | `agent.read` | `agent.{read,register,manage,suspend}`, `agent.policy.{read,manage}`, `agent.action.read`, `agent.approval.review`, `agent.audit.read`, `agent.incident.manage` |
| `data_security` | `modules/data-security` | AI Data Security | `/m/data-security` | `data_security.read` | `data_security.{read,scan}`, `data_security.classification.manage`, `data_security.policy.manage`, `data_security.incident.{read,manage}`, `data_security.remediation.manage`, `data_security.shadow_ai.read` |
| `knowledge_verification` | `modules/knowledge-verification` | AI Knowledge & Verification | `/m/knowledge-verification` | `knowledge.read` | `knowledge.{read,search,ingest,manage,admin}`, `knowledge.source.manage`, `knowledge.conflict.review`, `knowledge.verification.read` |
| `ai_operations` | `modules/ai-operations` | AI Operations Management | `/m/ai-operations` | `ai_ops.read` | `ai_ops.{read,admin}`, `ai_ops.tool.manage`, `ai_ops.vendor.manage`, `ai_ops.cost.{read,manage}`, `ai_ops.adoption.read`, `ai_ops.training.manage`, `ai_ops.request.manage` |

Module ids are fixed in `packages/shared-types/src/modules.ts` (`MODULE_IDS`). The install list is `MODULE_DEFINITIONS` in `packages/module-catalog/src/index.ts`; apps (web, worker, scripts) and `createTestPlatform` pass it to `createPlatform(env, { modules })`. `createPlatform` itself installs **no** modules by default — the core never imports module packages, which keeps the dependency graph acyclic (modules depend on `@eaop/platform`, not the reverse).

## `ModuleManifest` contract

Defined in `packages/module-registry/src/manifest.ts`.

| Field | Type | Meaning |
|---|---|---|
| `id` | `ModuleId` | One of `MODULE_IDS`. Never rename |
| `name`, `shortName`, `description`, `version` | `string` | Catalog display; synced to the `modules` table |
| `installStatus` | `"installed" \| "not_installed"` | `not_installed` = visible but cannot be enabled; even an `organization_modules.enabled = true` row is ignored |
| `icon` | `string` | lucide-react icon name for the shell |
| `basePath` | `string` | Must start with `/m/` (`ModuleRegistry.add` throws otherwise) |
| `dependsOn?` | `ModuleId[]` | `enable` requires these enabled; `disable` is refused while an enabled module depends on this one |
| `permissions` | `PermissionDefinition[]` | `{ key, description, risk? }`. Registered with `owner = id`. Namespaces `platform`, `org`, `role` are forbidden |
| `roleGrants?` | `Partial<Record<SystemRoleKey, string[]>>` | Extra permission patterns (`"ns.*"`, exact, `!exclusion`) granted to **system** roles at `bootstrap()` |
| `events?` | `EventContract[]` | Each contract's `owner` must equal the module id (`createPlatform` throws otherwise) |
| `notificationTypes?` | `Omit<NotificationTypeDefinition, "owner">[]` | Owner is set to the module id |
| `searchProviders?` | `Omit<SearchProvider, "owner">[]` | Owner is set to the module id |
| `policyKinds?` | `Omit<PolicyKind, "owner">[]` | Owner is set to the module id |
| `featureFlags?` | `{ key, description, defaultEnabled }[]` | Defaults; org/platform rows in `feature_flags` override |
| `navigation` | `{ label, href, permission? }[]` | `href` is relative to `basePath`; items hidden without `permission` |
| `entryPermission?` | `string` | Module hidden from navigation entirely without it |
| `healthCheck?` | `() => Promise<HealthStatus>` | Called by `modules.health()` for installed modules |
| `onEnable?`, `onDisable?` | `(ctx: TenantContext) => Promise<void>` | Called after the enable/disable transaction commits |

### `ModuleDefinition` and how `createPlatform` installs it

```ts
// packages/platform/src/platform.ts
export interface ModuleDefinition {
  manifest: ModuleManifest;
  /** Runs once the shared core is fully built (installed modules only). */
  install?: (platform: Platform) => void;
}
for (const { manifest: m } of definitions) {
  moduleRegistry.add(m);                                  // basePath + namespace checks
  permissionRegistry.register(m.id, m.permissions);       // owner = module id
  for (const [role, patterns] of Object.entries(m.roleGrants ?? {})) roleGrants[role] = [...(roleGrants[role] ?? []), ...(patterns ?? [])];
  for (const e of m.events ?? []) { /* owner must equal m.id */ eventRegistry.register(e); }
  for (const t of m.notificationTypes ?? []) notificationTypes.register({ ...t, owner: m.id });
  for (const s of m.searchProviders ?? []) search.register({ ...s, owner: m.id });
  for (const k of m.policyKinds ?? []) policyService.registerKind({ ...k, owner: m.id });
}
```

After every core service exists, `install(platform)` runs for each installed module. That is where a module constructs its services from the shared core (db, authorizer, audit, bus, notifications, ai, connectors, jobs, …), registers search providers / job handlers / event subscribers / AI policy hooks, and publishes its service in `platform.moduleServices` (keyed by module id) for the web and worker apps. Placeholders are bare manifests.

`bootstrap()` then upserts the `permissions` table, recomputes system-role permission sets including `roleGrants`, and upserts the `modules` table.

### Cross-module analytics (`platform.insights`)

A module may register one **insight provider** in its install hook: `platform.insights.register({ moduleId, label, collect(ctx) })`. `collect` returns a handful of aggregate metrics about the module's own domain (`{ key, label, value, unit: "count" | "usd" | "usd_per_year" | "percent", basis: "measured" | "estimated", href }`) — never names, content or per-person data. `platform.insights.collect(ctx)` returns the summaries of every provider whose module is enabled for the tenant; a failing provider is reported as unavailable without hiding the others. AI Operations Management builds its cross-module view on this instead of reading other modules' tables. All five other modules register a provider (`src/insights.ts`).

### AI routing policies

`platform.ai.registerRoutingPolicy(name, fn)` lets a module filter and reorder the candidate models for a request before the shared AI layer executes it. Policies may be async. AI Operations uses it to apply organization model-selection policies.

### Entitlements, feature flags and navigation

- **Entitlement** = row in `organization_modules` with `enabled = true` **and** manifest `installStatus = "installed"`. Toggled with `POST /api/v1/modules/:id/enable|disable` (`module.manage`), audited (`module.enabled` / `module.disabled`), published as events, and `onEnable` notifies `module.manage` holders (`core.module_changed`).
- **Permission interplay**: the authorizer denies any permission whose owner is a module that is not enabled for the tenant (`MODULE_NOT_ENABLED`), regardless of role grants. `authorizer.list(ctx)` omits such permissions.
- **Entry points**: call `modules.requireEnabled(ctx, id)` or pass `module: "<id>"` to `route()`.
- **Feature flags** (`modules.isFlagEnabled(ctx, key)`): org row → platform row (`organization_id IS NULL`) → manifest `defaultEnabled`. Rows support `rollout_percent` using `hashBucket("<orgId>:<key>")`. `PUT /api/v1/feature-flags/:key` writes an org override (audited).
- **Navigation** (`modules.navigation(ctx)`, `GET /api/v1/navigation`): every registered module is returned with a `state` of `enabled`, `disabled` or `not_installed`. Enabled modules are dropped when the user lacks `entryPermission`; their items are filtered by item `permission` and prefixed with `basePath`. The web shell's module nav is driven by this call (`apps/web/src/lib/viewer.ts` → `Viewer.navigation`).

---

## Module Development Contract

A module **MUST**:

1. **Use shared authentication.** Receive a `TenantContext` from `route()` or `getViewer()`. Never read cookies, tokens or API keys yourself.
2. **Use shared organizations.** Tenant identity is `ctx.organizationId` only. Never accept an organization id from request input.
3. **Use shared RBAC.** Declare permissions in the manifest; call `platform.rbac.authorizer.require(ctx, "<perm>", resource?)` at the top of every service method (and set `permission` on routes). Never invent permission checks or role tables.
4. **Use the shared audit log.** Call `platform.audit.record(ctx, { module: "<id>", action: "<ns>.<verb>", resourceType, resourceId, before, after, metadata })` for every state change; use namespaced actions (e.g. `workflow.approved`).
5. **Use shared connectors.** Reach external systems only via `platform.connectors.execute(ctx, connectorId, req, { moduleId })` and discover them with `findByCapability`. No direct HTTP to tenant systems; no credential storage.
6. **Use the shared AI layer.** Call models only via `platform.ai.execute(ctx, { moduleId, useCase, ... })`. Importing `openai` or `@anthropic-ai/sdk` is a lint error.
7. **Use shared notifications.** Declare `notificationTypes` and call `platform.notifications.notify(ctx, ...)`.
8. **Use the design system.** Build UI with `@eaop/design-system` components and tokens.
9. **Use shared observability.** Use `platform.logger` (child loggers), `platform.metrics`, `platform.tracer`; never `console.log` (lint error outside scripts/worker).
10. **Respect entitlements.** Gate every entry point with `module: "<id>"` on routes or `modules.requireEnabled`; module permissions are automatically denied when disabled.
11. **Own tenant data correctly.** Every tenant-owned table has `organization_id uuid NOT NULL REFERENCES organizations(id)` and its migration calls `SELECT eaop_enable_tenant_rls('<table>');`. Migrations live in `modules/<name>/migrations/*.sql` and are discovered automatically by `packages/db/scripts/module-migrations.ts` (history owner `module:<name>`; applied after core migrations, modules in alphabetical order).
12. **Access the DB only through `@eaop/db`.** Use `platform.db.withTenant(scopeOf(ctx), tx => ...)`. Importing `pg` from `modules/**` is a lint error. `withSystem` is reserved for platform operations and must not be used to read tenant data on behalf of a user.
13. **Register through the manifest.** Permissions, events (with zod payload schemas), search providers, notification types, policy kinds, feature flags, navigation.
14. **Never duplicate infrastructure.** No module-owned queues, schedulers, secret storage, rate limiters, loggers or HTTP clients for tenant systems; use `platform.jobs`, `platform.events.bus`, `platform.secrets`, `platform.rateLimiter`.
15. **Ship a tenant-isolation test** for every new table and service (see below). `tests/integration/tenant-isolation.test.ts` already asserts that every table with `organization_id` has RLS enabled and forced.

---

## Installing a module — reference implementation (Workflow Intelligence)

Recommended build order: **Workflow Intelligence → Integration → Agent Governance → Data Security → Knowledge & Verification → AI Operations.** Workflow Intelligence is the worked example; copy its layout.

| Piece | Where | Notes |
|---|---|---|
| Manifest + `ModuleDefinition` | `modules/workflow-intelligence/src/index.ts` | `installStatus: "installed"`, permissions, `roleGrants`, event contracts with Zod payload schemas, notification types, navigation. `install()` builds the service and registers search |
| Tables | `modules/workflow-intelligence/migrations/0001_*.sql` | Module-prefixed (`wi_*`), every table has `organization_id` and ends with `SELECT eaop_enable_tenant_rls(...)`. Auto-applied by `pnpm db:migrate` (owner `module:workflow-intelligence`) and by the test global setup |
| Drizzle mirror | `src/schema.ts` | Imports shared tables (`organizations`, `users`, `connectors`, `ai_runs`) for FKs; numeric columns use `mode: "number"` |
| Pure engines | `src/scoring.ts`, `src/roi.ts`, `src/csv.ts`, `src/redesign.ts` | No I/O — unit-tested directly |
| Service | `src/service.ts` | Every method: `authorizer.require` → `db.withTenant(scopeOf(ctx))` → `audit.record` + `bus.publish` (+ `notifications.notify`). Validation errors become `VALIDATION_FAILED` |
| Catalog entry | `packages/module-catalog/src/index.ts` | Replace `{ manifest }` with the module's `ModuleDefinition` |
| API | `apps/web/src/app/api/v1/m/<module>/…/route.ts` | `route({ module: "<id>", permission, … })`; get the service with the module's typed accessor (`workflowService(platform)`) |
| UI | `apps/web/src/app/(app)/m/<module>/…` + `apps/web/src/components/<module>/` | A module `layout.tsx` gates entitlement and renders sub-navigation from `viewer.navigation`; static folders take precedence over the catch-all `m/[module]/[[...rest]]` |
| Tests | `tests/unit/<module>-*.test.ts`, `tests/integration/<module>.test.ts` | CRUD, tenant isolation, RBAC, engines, events, AI logging |

Rules learned building it:

- Add the package to `apps/web/next.config.ts` `transpilePackages` and to the app's `package.json`.
- Client components may import **types only** from a module package (it pulls in `pg`); share formatting helpers in a `"use client"` file.
- One transaction is one connection: run queries sequentially (no `Promise.all` on `tx`).
- Background work goes through `platform.jobs` (register handlers in `install`); cross-module reactions through `platform.events.bus.subscribe` (Integration's event triggers subscribe to `"*"`).
- Modules can extend each other without a package dependency through core extension points: `policies.registerInterceptor(kind, name, fn)` adds a deny-overrides check to another module's policy kind (Agent Governance enforces agent bindings inside `integration_action` this way), `apiKeys.registerActorBinder` maps API keys to a module actor type, and `authorizer.registerActorResolver` supplies that actor's permissions.
- Policy-gated modules register a policy kind (`policyKinds`) and call `platform.policies.evaluateKind` before acting; reuse `platform.policyEngine` for any other rule evaluation instead of writing an evaluator.
- Render anything locale/timezone/ICU-dependent identically on server and client (e.g. a mount-gated `LocalDate`, explicit `Intl` fraction digits) or hydration fails in production.

The existing RLS assertions in `tests/integration/tenant-isolation.test.ts` ("every table with organization_id has RLS enabled AND forced", "A's scope sees zero rows owned by B in every tenant table") automatically cover module tables because module migrations are applied in tests.
