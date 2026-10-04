# Module System

The platform is one shared core plus six modular applications. A module is a workspace package under `modules/<name>` that exports a `ModuleManifest`. The core installs manifests into its **shared** registries; modules never build their own auth, RBAC, audit, connectors, AI clients, notifications or database access.

## The six modules

All six are placeholders today (`installStatus: "not_installed"`, `version: "0.0.0"`). They reserve identity, route prefix, permission keys, navigation and event names (`RESERVED_EVENT_TYPES` in each `src/index.ts`). They appear in `GET /api/v1/modules` and in navigation with `state: "not_installed"`, report health `not_configured` ("Module not yet installed"), and `enable` returns `CONFLICT` ("… is not installed on this platform yet.").

| Id | Package dir | Name | `basePath` | Entry permission | Reserved permissions |
|---|---|---|---|---|---|
| `workflow_intelligence` | `modules/workflow-intelligence` | AI Workflow Intelligence | `/m/workflow-intelligence` | `workflow.read` | `workflow.{read,create,update,delete,analyze,approve}`, `workflow.roi.{read,manage}`, `workflow.implementation.manage` |
| `integration_hub` | `modules/integration-hub` | Enterprise AI Integration | `/m/integration-hub` | `integration.read` | `integration.{read,create,manage,execute,approve,admin}`, `integration.connector.use`, `integration.history.read` |
| `agent_governance` | `modules/agent-governance` | AI Agent Governance | `/m/agent-governance` | `agent.read` | `agent.{read,register,manage,suspend}`, `agent.policy.{read,manage}`, `agent.action.read`, `agent.approval.review`, `agent.audit.read`, `agent.incident.manage` |
| `data_security` | `modules/data-security` | AI Data Security | `/m/data-security` | `data_security.read` | `data_security.{read,scan}`, `data_security.classification.manage`, `data_security.policy.manage`, `data_security.incident.{read,manage}`, `data_security.remediation.manage`, `data_security.shadow_ai.read` |
| `knowledge_verification` | `modules/knowledge-verification` | AI Knowledge & Verification | `/m/knowledge-verification` | `knowledge.read` | `knowledge.{read,search,ingest,manage,admin}`, `knowledge.source.manage`, `knowledge.conflict.review`, `knowledge.verification.read` |
| `ai_operations` | `modules/ai-operations` | AI Operations Management | `/m/ai-operations` | `ai_ops.read` | `ai_ops.{read,admin}`, `ai_ops.tool.manage`, `ai_ops.vendor.manage`, `ai_ops.cost.{read,manage}`, `ai_ops.adoption.read`, `ai_ops.training.manage`, `ai_ops.request.manage` |

Module ids are fixed in `packages/shared-types/src/modules.ts` (`MODULE_IDS`). The default install list is `MODULE_MANIFESTS` in `packages/platform/src/platform.ts`.

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

### How `createPlatform` installs a manifest

```ts
// packages/platform/src/platform.ts
for (const m of o.modules ?? MODULE_MANIFESTS) {
  moduleRegistry.add(m);                                  // basePath + namespace checks
  permissionRegistry.register(m.id, m.permissions);       // owner = module id
  for (const [role, patterns] of Object.entries(m.roleGrants ?? {})) roleGrants[role] = [...(roleGrants[role] ?? []), ...(patterns ?? [])];
  for (const e of m.events ?? []) { /* owner must equal m.id */ eventRegistry.register(e); }
  for (const t of m.notificationTypes ?? []) notificationTypes.register({ ...t, owner: m.id });
  for (const s of m.searchProviders ?? []) search.register({ ...s, owner: m.id });
  for (const k of m.policyKinds ?? []) policyService.registerKind({ ...k, owner: m.id });
}
```

`bootstrap()` then upserts the `permissions` table, recomputes system-role permission sets including `roleGrants`, and upserts the `modules` table.

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

## Adding the first module (Workflow Intelligence)

Recommended build order: **Workflow Intelligence → Integration → Agent Governance → Data Security → Knowledge & Verification → AI Operations.**

The skeletons below are illustrative; none of this code exists yet.

### 1. Manifest (`modules/workflow-intelligence/src/index.ts`)

```ts
import { z } from "zod";
import { type ModuleManifest } from "@eaop/module-registry";

const id = z.string().uuid();

export const manifest: ModuleManifest = {
  id: "workflow_intelligence",
  name: "AI Workflow Intelligence",
  shortName: "Workflow Intelligence",
  description: "Find, score and redesign the workflows where AI creates measurable value, and track realized ROI.",
  version: "0.1.0",
  installStatus: "installed",                          // was "not_installed"
  icon: "Workflow",
  basePath: "/m/workflow-intelligence",
  entryPermission: "workflow.read",
  permissions: [
    { key: "workflow.read", description: "View workflows.", risk: "low" },
    { key: "workflow.create", description: "Create workflows.", risk: "low" },
    { key: "workflow.analyze", description: "Run AI analysis on a workflow.", risk: "medium" },
    { key: "workflow.approve", description: "Approve opportunities.", risk: "high" },
    // ...keep the remaining reserved keys
  ],
  roleGrants: {
    analyst: ["workflow.read", "workflow.create", "workflow.analyze"],
    department_leader: ["workflow.read", "workflow.approve"],
    executive: ["workflow.read", "workflow.roi.read"],
    // org_admin already receives every registered permission via "*"
  },
  events: [
    { type: "workflow.created", owner: "workflow_intelligence", version: 1, description: "A workflow was added.",
      schema: z.object({ workflowId: id, name: z.string() }) },
    { type: "workflow.analyzed", owner: "workflow_intelligence", version: 1, description: "AI analysis completed.",
      schema: z.object({ workflowId: id, runId: id, score: z.number() }) },
  ],
  notificationTypes: [
    { key: "workflow.analysis_ready", description: "A workflow analysis finished.", defaultPriority: "normal", channels: ["in_app"] },
  ],
  searchProviders: [/* see step 3 */],
  navigation: [
    { label: "Dashboard", href: "/", permission: "workflow.read" },
    { label: "Inventory", href: "/workflows", permission: "workflow.read" },
  ],
};
export default manifest;
```

Add `zod`, `@eaop/db`, `@eaop/platform` (and `drizzle-orm` if you declare Drizzle tables) to the module's `package.json`, and add the package to `transpilePackages` in `apps/web/next.config.ts` (already listed for all six).

### 2. Migration (`modules/workflow-intelligence/migrations/0001_workflows.sql`)

```sql
CREATE TABLE workflows (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'draft',
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz(3) NOT NULL DEFAULT now(),
  updated_at      timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX workflows_org_idx ON workflows (organization_id, created_at);
CREATE UNIQUE INDEX workflows_org_name_uq ON workflows (organization_id, name);

-- Mandatory: ENABLE + FORCE RLS, tenant_isolation policy, grants to eaop_runtime.
SELECT eaop_enable_tenant_rls('workflows');
```

`pnpm db:migrate` picks it up as `module:workflow-intelligence/0001_workflows.sql`. Mirror the table in Drizzle (e.g. `modules/workflow-intelligence/src/schema.ts` with `pgTable("workflows", ...)`) so the service gets typed queries.

### 3. Service (`modules/workflow-intelligence/src/service.ts`)

```ts
import { and, eq, scopeOf } from "@eaop/db";
import { type Platform } from "@eaop/platform";
import { notFound, type TenantContext } from "@eaop/shared-types";
import { workflows } from "./schema";

const MODULE = "workflow_intelligence" as const;

export function createWorkflowService(p: Platform) {
  return {
    async create(ctx: TenantContext, input: { name: string; description?: string }) {
      await p.rbac.authorizer.require(ctx, "workflow.create");
      return p.db.withTenant(scopeOf(ctx), async (tx) => {
        const [row] = await tx.insert(workflows).values({
          organizationId: ctx.organizationId,                // RLS WITH CHECK rejects any other org
          name: input.name,
          description: input.description ?? "",
          createdBy: ctx.actor.type === "user" ? ctx.actor.id : null,
        }).returning();
        // Same transaction: audit + outbox commit atomically with the insert.
        await p.audit.record(ctx, { module: MODULE, action: "workflow.created", resourceType: "workflow", resourceId: row!.id, after: input });
        await p.events.bus.publish(ctx, "workflow.created", { workflowId: row!.id, name: row!.name });
        return row!;
      });
    },

    async analyze(ctx: TenantContext, workflowId: string) {
      await p.rbac.authorizer.require(ctx, "workflow.analyze", { type: "workflow", id: workflowId });
      const [wf] = await p.db.withTenant(scopeOf(ctx), (tx) =>
        tx.select().from(workflows).where(and(eq(workflows.id, workflowId), eq(workflows.organizationId, ctx.organizationId))).limit(1));
      if (!wf) throw notFound("Workflow", workflowId);
      const result = await p.ai.execute(ctx, {
        moduleId: MODULE,
        useCase: "workflow.analyze",
        tier: "standard",
        dataClassification: "internal",
        responseFormat: "json",
        promptTemplate: { id: "workflow.analyze", version: "1" },
        references: { workflowId },                          // ids only, never content
        system: "Score this workflow for AI automation potential. Return {\"score\": number}.",
        messages: [{ role: "user", content: `${wf.name}\n\n${wf.description}` }],
      });
      const score = Number((JSON.parse(result.text) as { score?: number }).score ?? 0);
      await p.audit.record(ctx, { module: MODULE, action: "workflow.analyzed", resourceType: "workflow", resourceId: workflowId, metadata: { runId: result.runId, score } });
      await p.events.bus.publish(ctx, "workflow.analyzed", { workflowId, runId: result.runId, score });
      return { score, runId: result.runId };
    },
  };
}
```

Notes: `withTenant` is re-entrant, so `audit.record` and `bus.publish` called inside it join the same transaction. `ai.execute` already authorizes `ai.use`, rate-limits, applies `ai_usage` policies, logs the run and meters cost.

### 4. API route (`apps/web/src/app/api/v1/m/workflow-intelligence/workflows/route.ts`)

```ts
import { z } from "zod";
import { route } from "@/lib/api";
import { createWorkflowService } from "@eaop/module-workflow-intelligence/service"; // add an export entry

export const POST = route({
  auth: "any",                          // session or API key
  module: "workflow_intelligence",      // MODULE_NOT_ENABLED when disabled
  permission: "workflow.create",
  idempotent: true,
  body: z.object({ name: z.string().min(1).max(160), description: z.string().max(4000).optional() }),
  handler: ({ platform, ctx, body }) => createWorkflowService(platform).create(ctx, body),
});
```

### 5. UI page (`apps/web/src/app/(app)/m/workflow-intelligence/page.tsx`)

```tsx
import { requireViewer } from "@/lib/viewer";
import { getPlatform } from "@/lib/platform";

export default async function WorkflowDashboard() {
  const viewer = await requireViewer();
  const platform = await getPlatform();
  if (!(await platform.modules.isEnabled(viewer.ctx.organizationId, "workflow_intelligence"))) {
    return <p>This module is not enabled for your organization.</p>;   // use the design-system empty state
  }
  // Service calls with viewer.ctx enforce permissions server-side.
  return <div>…</div>;
}
```

Pages under `(app)` are wrapped by the shell (`apps/web/src/app/(app)/layout.tsx`, `apps/web/src/components/app-shell.tsx`). The generic catch-all `apps/web/src/app/(app)/m/[module]/[[...rest]]/page.tsx` renders `NotInstalledState` for placeholders, a "Not enabled for your organization" state with an **Enable module** action (shown to `module.manage` holders) for installed-but-disabled modules, and "Module UI not provided" for enabled modules without pages. A static `m/workflow-intelligence/` folder takes precedence over that dynamic segment. Server pages must not pass functions (e.g. a `DataTable` cell renderer) to client components — put tables in a client component under `apps/web/src/components`.

### 6. Tests

- **Unit**: pure logic (scoring, schemas) under `tests/unit/`.
- **Integration**: `tests/integration/workflow-intelligence.test.ts` using `createTestPlatform({ modules: [...] })` with the installed manifest, `createOrg`, `addMember`, `expectCode`.
- **Module migrations in tests**: `tests/helpers/global-setup.ts` applies core migrations **and** `moduleMigrationSources()`, so `modules/<name>/migrations/*.sql` are present in the test database automatically.
- **Tenant isolation (mandatory)** — copy the pattern of `tests/integration/tenant-isolation.test.ts`:

```ts
it("workflows of B are invisible and immutable from A", async () => {
  await p.modules.enable(A.adminCtx(), "workflow_intelligence");
  await p.modules.enable(B.adminCtx(), "workflow_intelligence");
  const wf = await svc.create(B.adminCtx(), { name: "B secret flow" });
  await expectCode(svc.analyze(A.adminCtx(), wf.id), "NOT_FOUND");
  const n = await p.db.withTenant({ organizationId: A.org.id }, async (tx) =>
    (await tx.execute(sql`select count(*)::int as n from workflows where organization_id = ${B.org.id}`)).rows[0]);
  expect(n).toEqual({ n: 0 });
});
it("module permissions are denied while the module is disabled", async () => {
  await p.modules.disable(A.adminCtx(), "workflow_intelligence");
  await expectCode(svc.create(A.adminCtx(), { name: "x" }), "MODULE_NOT_ENABLED");
});
```

The existing RLS assertions ("every table with organization_id has RLS enabled AND forced", "A's scope sees zero rows owned by B in every tenant table") automatically cover the new table once module migrations are applied in tests.
