import { and, eq, featureFlags, modules, organizationModules, scopeOf, type Database } from "@eaop/db";
import { AuditActions, type AuditService } from "@eaop/audit";
import { type EventBus } from "@eaop/events";
import { type NotificationService } from "@eaop/notifications";
import { type Authorizer, type EntitlementChecker } from "@eaop/rbac";
import { hashBucket } from "@eaop/security";
import { AppError, conflict, isModuleId, notFound, type HealthStatus, type ModuleId, type TenantContext } from "@eaop/shared-types";
import { type ModuleRegistry } from "./manifest";

export interface OrgModuleView {
  id: ModuleId;
  name: string;
  shortName: string;
  description: string;
  version: string;
  icon: string;
  basePath: string;
  installStatus: "installed" | "not_installed";
  enabled: boolean;
  enabledAt: string | null;
  dependsOn: ModuleId[];
  permissions: string[];
}

export interface NavigationModule {
  id: ModuleId;
  name: string;
  shortName: string;
  icon: string;
  basePath: string;
  state: "enabled" | "disabled" | "not_installed";
  items: Array<{ label: string; href: string }>;
}

export interface ModuleService extends EntitlementChecker {
  syncCatalog(): Promise<void>;
  list(ctx: TenantContext): Promise<OrgModuleView[]>;
  enable(ctx: TenantContext, moduleId: string): Promise<OrgModuleView>;
  disable(ctx: TenantContext, moduleId: string): Promise<OrgModuleView>;
  /** Shell navigation: entitlement + permission aware. */
  navigation(ctx: TenantContext): Promise<NavigationModule[]>;
  /** Throws MODULE_NOT_ENABLED. Use at the top of every module entry point. */
  requireEnabled(ctx: TenantContext, moduleId: ModuleId): Promise<void>;
  isFlagEnabled(ctx: TenantContext, key: string): Promise<boolean>;
  listFlags(ctx: TenantContext): Promise<Array<{ key: string; moduleId: string | null; description: string; enabled: boolean; source: "organization" | "platform" | "default" }>>;
  setFlag(ctx: TenantContext, key: string, enabled: boolean): Promise<void>;
  health(): Promise<Array<{ moduleId: ModuleId; status: HealthStatus }>>;
  invalidate(organizationId?: string): void;
}

const CACHE_TTL_MS = 5_000;

export function createModuleService(deps: { db: Database; registry: ModuleRegistry; authorizer: Authorizer; audit: AuditService; bus: EventBus; notifications: NotificationService }): ModuleService {
  const { db, registry, authorizer, audit, bus } = deps;
  const cache = new Map<string, { at: number; enabled: Set<string> }>();

  async function enabledSet(organizationId: string): Promise<Set<string>> {
    const hit = cache.get(organizationId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.enabled;
    const rows = await db.withTenant({ organizationId }, (tx) =>
      tx.select({ moduleId: organizationModules.moduleId }).from(organizationModules).where(and(eq(organizationModules.organizationId, organizationId), eq(organizationModules.enabled, true))),
    );
    // Only installed modules count as enabled, even if a row says otherwise.
    const enabled = new Set(rows.map((r) => r.moduleId).filter((id) => isModuleId(id) && registry.get(id)?.installStatus === "installed"));
    cache.set(organizationId, { at: Date.now(), enabled });
    return enabled;
  }

  async function view(ctx: TenantContext, id: ModuleId): Promise<OrgModuleView> {
    const m = registry.get(id)!;
    const [row] = await db.withTenant(scopeOf(ctx), (tx) =>
      tx.select().from(organizationModules).where(and(eq(organizationModules.organizationId, ctx.organizationId), eq(organizationModules.moduleId, id))).limit(1),
    );
    return toView(m.id, row);
  }

  function toView(id: ModuleId, row?: typeof organizationModules.$inferSelect): OrgModuleView {
    const m = registry.get(id)!;
    return {
      id: m.id,
      name: m.name,
      shortName: m.shortName,
      description: m.description,
      version: m.version,
      icon: m.icon,
      basePath: m.basePath,
      installStatus: m.installStatus,
      enabled: m.installStatus === "installed" && !!row?.enabled,
      enabledAt: row?.enabledAt?.toISOString() ?? null,
      dependsOn: m.dependsOn ?? [],
      permissions: m.permissions.map((p) => p.key),
    };
  }

  function getManifest(moduleId: string) {
    if (!isModuleId(moduleId)) throw notFound("Module", moduleId);
    const m = registry.get(moduleId);
    if (!m) throw notFound("Module", moduleId);
    return m;
  }

  async function flagValue(organizationId: string, key: string) {
    const rows = await db.withTenant({ organizationId }, (tx) => tx.select().from(featureFlags).where(eq(featureFlags.key, key)));
    const org = rows.find((r) => r.organizationId === organizationId);
    const platform = rows.find((r) => r.organizationId === null);
    const manifestDefault = registry
      .list()
      .flatMap((m) => m.featureFlags ?? [])
      .find((f) => f.key === key);
    const row = org ?? platform;
    if (row) {
      const inRollout = hashBucket(`${organizationId}:${key}`) < row.rolloutPercent;
      return { enabled: row.enabled && inRollout, source: (org ? "organization" : "platform") as "organization" | "platform", description: row.description ?? manifestDefault?.description ?? "", moduleId: row.moduleId };
    }
    return { enabled: manifestDefault?.defaultEnabled ?? false, source: "default" as const, description: manifestDefault?.description ?? "", moduleId: null };
  }

  return {
    async isEnabled(organizationId, moduleId) {
      return (await enabledSet(organizationId)).has(moduleId);
    },
    invalidate(organizationId) {
      if (organizationId) cache.delete(organizationId);
      else cache.clear();
    },

    async syncCatalog() {
      await db.withSystem("modules.sync_catalog", async (tx) => {
        for (const m of registry.list()) {
          await tx
            .insert(modules)
            .values({ id: m.id, name: m.name, description: m.description, version: m.version, installStatus: m.installStatus })
            .onConflictDoUpdate({ target: modules.id, set: { name: m.name, description: m.description, version: m.version, installStatus: m.installStatus, updatedAt: new Date() } });
        }
      });
    },

    async list(ctx) {
      await authorizer.require(ctx, "module.read");
      const rows = await db.withTenant(scopeOf(ctx), (tx) => tx.select().from(organizationModules).where(eq(organizationModules.organizationId, ctx.organizationId)));
      return registry.list().map((m) => toView(m.id, rows.find((r) => r.moduleId === m.id)));
    },

    async enable(ctx, moduleId) {
      await authorizer.require(ctx, "module.manage");
      const m = getManifest(moduleId);
      if (m.installStatus !== "installed") throw new AppError("CONFLICT", `${m.name} is not installed on this platform yet.`);
      const enabled = await enabledSet(ctx.organizationId);
      const missing = (m.dependsOn ?? []).filter((d) => !enabled.has(d));
      if (missing.length) throw conflict(`Enable required modules first: ${missing.join(", ")}`);
      await db.withTenant(scopeOf(ctx), async (tx) => {
        await tx
          .insert(organizationModules)
          .values({ organizationId: ctx.organizationId, moduleId: m.id, enabled: true, enabledAt: new Date(), enabledBy: ctx.actor.type === "user" ? ctx.actor.id : null })
          .onConflictDoUpdate({
            target: [organizationModules.organizationId, organizationModules.moduleId],
            set: { enabled: true, enabledAt: new Date(), enabledBy: ctx.actor.type === "user" ? ctx.actor.id : null, updatedAt: new Date() },
          });
        await audit.record(ctx, { action: AuditActions.MODULE_ENABLED, module: m.id, resourceType: "module", resourceId: m.id, after: { enabled: true } });
        await bus.publish(ctx, "module.enabled", { moduleId: m.id });
      });
      cache.delete(ctx.organizationId);
      await m.onEnable?.(ctx);
      await deps.notifications.notify(ctx, { type: "core.module_changed", title: `${m.name} enabled`, actionUrl: m.basePath, recipients: { permission: "module.manage" } });
      return view(ctx, m.id);
    },

    async disable(ctx, moduleId) {
      await authorizer.require(ctx, "module.manage");
      const m = getManifest(moduleId);
      const enabled = await enabledSet(ctx.organizationId);
      const dependents = registry.list().filter((x) => x.dependsOn?.includes(m.id) && enabled.has(x.id));
      if (dependents.length) throw conflict(`Disable dependent modules first: ${dependents.map((d) => d.name).join(", ")}`);
      await db.withTenant(scopeOf(ctx), async (tx) => {
        await tx
          .update(organizationModules)
          .set({ enabled: false, updatedAt: new Date() })
          .where(and(eq(organizationModules.organizationId, ctx.organizationId), eq(organizationModules.moduleId, m.id)));
        await audit.record(ctx, { action: AuditActions.MODULE_DISABLED, module: m.id, resourceType: "module", resourceId: m.id, after: { enabled: false } });
        await bus.publish(ctx, "module.disabled", { moduleId: m.id });
      });
      cache.delete(ctx.organizationId);
      await m.onDisable?.(ctx);
      return view(ctx, m.id);
    },

    async requireEnabled(ctx, moduleId) {
      if (!(await enabledSet(ctx.organizationId)).has(moduleId)) throw new AppError("MODULE_NOT_ENABLED", undefined, { moduleId });
    },

    async navigation(ctx) {
      const enabled = await enabledSet(ctx.organizationId);
      const out: NavigationModule[] = [];
      for (const m of registry.list()) {
        const state: NavigationModule["state"] = m.installStatus !== "installed" ? "not_installed" : enabled.has(m.id) ? "enabled" : "disabled";
        if (state === "enabled") {
          if (m.entryPermission && !(await authorizer.can(ctx, m.entryPermission))) continue;
          const items: NavigationModule["items"] = [];
          for (const item of m.navigation) {
            if (!item.permission || (await authorizer.can(ctx, item.permission))) items.push({ label: item.label, href: `${m.basePath}${item.href}` });
          }
          out.push({ id: m.id, name: m.name, shortName: m.shortName, icon: m.icon, basePath: m.basePath, state, items });
        } else {
          out.push({ id: m.id, name: m.name, shortName: m.shortName, icon: m.icon, basePath: m.basePath, state, items: [] });
        }
      }
      return out;
    },

    async isFlagEnabled(ctx, key) {
      return (await flagValue(ctx.organizationId, key)).enabled;
    },

    async listFlags(ctx) {
      await authorizer.require(ctx, "module.read");
      const rows = await db.withTenant(scopeOf(ctx), (tx) => tx.select({ key: featureFlags.key }).from(featureFlags));
      const keys = new Set([...rows.map((r) => r.key), ...registry.list().flatMap((m) => (m.featureFlags ?? []).map((f) => f.key))]);
      const out = [];
      for (const key of [...keys].sort()) out.push({ key, ...(await flagValue(ctx.organizationId, key)) });
      return out;
    },

    async setFlag(ctx, key, enabled) {
      await authorizer.require(ctx, "module.manage");
      if (!/^[a-z][a-z0-9_.-]{2,100}$/.test(key)) throw new AppError("VALIDATION_FAILED", "Invalid flag key.");
      const before = await flagValue(ctx.organizationId, key);
      await db.withTenant(scopeOf(ctx), async (tx) => {
        const existing = await tx.select().from(featureFlags).where(and(eq(featureFlags.key, key), eq(featureFlags.organizationId, ctx.organizationId))).limit(1);
        if (existing[0]) await tx.update(featureFlags).set({ enabled, updatedAt: new Date() }).where(eq(featureFlags.id, existing[0].id));
        else await tx.insert(featureFlags).values({ key, organizationId: ctx.organizationId, enabled, moduleId: before.moduleId });
        await audit.record(ctx, { action: AuditActions.FEATURE_FLAG_CHANGED, resourceType: "feature_flag", resourceId: key, before: { enabled: before.enabled }, after: { enabled } });
      });
    },

    async health() {
      const out: Array<{ moduleId: ModuleId; status: HealthStatus }> = [];
      for (const m of registry.list()) {
        if (m.installStatus !== "installed") {
          out.push({ moduleId: m.id, status: { state: "not_configured", message: "Module not yet installed", checkedAt: new Date().toISOString() } });
          continue;
        }
        try {
          out.push({ moduleId: m.id, status: (await m.healthCheck?.()) ?? { state: "healthy", checkedAt: new Date().toISOString() } });
        } catch (err) {
          out.push({ moduleId: m.id, status: { state: "unhealthy", message: (err as Error).message, checkedAt: new Date().toISOString() } });
        }
      }
      return out;
    },
  };
}

