import { and, eq, memberRoles, memberships, organizations, rolePermissions, scopeOf, type Database } from "@eaop/db";
import { type AuditService } from "@eaop/audit";
import { AppError, isModuleId, type ModuleId, type TenantContext } from "@eaop/shared-types";
import { type PermissionRegistry } from "./permissions";

export interface ResourceRef {
  type: string;
  id: string;
}

export interface EffectivePermissions {
  orgWide: Set<string>;
  /** Grants limited to a module or a specific resource ("type:id"). */
  scoped: Array<{ permission: string; scopeType: "module" | "resource"; scopeId: string }>;
  organizationStatus: string;
}

export interface EntitlementChecker {
  isEnabled(organizationId: string, moduleId: ModuleId): Promise<boolean>;
}

/** Extension point: e.g. Agent Governance resolves permissions for "agent" actors. */
export type ActorPermissionResolver = (ctx: TenantContext) => Promise<{ orgWide: string[]; scoped?: EffectivePermissions["scoped"] }>;

export interface Authorizer {
  effective(ctx: TenantContext): Promise<EffectivePermissions>;
  can(ctx: TenantContext, permission: string, resource?: ResourceRef): Promise<boolean>;
  /** Throws FORBIDDEN / MODULE_NOT_ENABLED / ORGANIZATION_SUSPENDED. Denials are audited. */
  require(ctx: TenantContext, permission: string, resource?: ResourceRef): Promise<void>;
  /** All permission keys the actor holds org-wide (for UI hints only — never for enforcement). */
  list(ctx: TenantContext): Promise<string[]>;
  registerActorResolver(actorType: string, resolver: ActorPermissionResolver): void;
  setEntitlements(checker: EntitlementChecker): void;
}

export function createAuthorizer(deps: { db: Database; registry: PermissionRegistry; audit: AuditService }): Authorizer {
  const { db, registry, audit } = deps;
  const resolvers = new Map<string, ActorPermissionResolver>();
  let entitlements: EntitlementChecker | undefined;

  async function load(ctx: TenantContext): Promise<EffectivePermissions> {
    const cached = ctx.cache?.get("rbac.effective") as EffectivePermissions | undefined;
    if (cached) return cached;

    const result = await db.withTenant(scopeOf(ctx), async (tx) => {
      const [org] = await tx.select({ status: organizations.status }).from(organizations).where(eq(organizations.id, ctx.organizationId)).limit(1);
      const status = org?.status ?? "missing";
      const eff: EffectivePermissions = { orgWide: new Set(), scoped: [], organizationStatus: status };
      if (ctx.actor.type === "user") {
        const rows = await tx
          .select({ permission: rolePermissions.permissionKey, scopeType: memberRoles.scopeType, scopeId: memberRoles.scopeId })
          .from(memberships)
          .innerJoin(memberRoles, eq(memberRoles.membershipId, memberships.id))
          .innerJoin(rolePermissions, eq(rolePermissions.roleId, memberRoles.roleId))
          .where(and(eq(memberships.organizationId, ctx.organizationId), eq(memberships.userId, ctx.actor.id), eq(memberships.status, "active")));
        for (const r of rows) {
          if (r.scopeType && r.scopeId) eff.scoped.push({ permission: r.permission, scopeType: r.scopeType, scopeId: r.scopeId });
          else eff.orgWide.add(r.permission);
        }
      } else if (ctx.actor.type === "api_key") {
        for (const s of ctx.actor.scopes ?? []) if (registry.has(s)) eff.orgWide.add(s);
      } else if (ctx.actor.type === "system") {
        for (const p of registry.list()) if (p.key !== "platform.admin") eff.orgWide.add(p.key);
      } else {
        const resolver = resolvers.get(ctx.actor.type);
        if (resolver) {
          const r = await resolver(ctx);
          r.orgWide.forEach((p) => eff.orgWide.add(p));
          eff.scoped.push(...(r.scoped ?? []));
        }
        // No resolver → no permissions (deny by default).
      }
      return eff;
    });
    ctx.cache?.set("rbac.effective", result);
    return result;
  }

  async function decide(ctx: TenantContext, permission: string, resource?: ResourceRef): Promise<{ ok: true } | { ok: false; code: "FORBIDDEN" | "MODULE_NOT_ENABLED" | "ORGANIZATION_SUSPENDED"; reason: string }> {
    const def = registry.get(permission);
    if (!def) return { ok: false, code: "FORBIDDEN", reason: "unknown_permission" };

    if (permission === "platform.admin") {
      return ctx.actor.isPlatformAdmin ? { ok: true } : { ok: false, code: "FORBIDDEN", reason: "not_platform_admin" };
    }

    const eff = await load(ctx);
    if (eff.organizationStatus !== "active") return { ok: false, code: "ORGANIZATION_SUSPENDED", reason: `organization_${eff.organizationStatus}` };

    if (def.owner !== "core" && isModuleId(def.owner)) {
      if (!entitlements || !(await entitlements.isEnabled(ctx.organizationId, def.owner))) {
        return { ok: false, code: "MODULE_NOT_ENABLED", reason: `module_${def.owner}_not_enabled` };
      }
    }

    if (eff.orgWide.has(permission)) return { ok: true };
    for (const g of eff.scoped) {
      if (g.permission !== permission) continue;
      if (g.scopeType === "module" && g.scopeId === def.owner) return { ok: true };
      if (g.scopeType === "resource" && resource && g.scopeId === `${resource.type}:${resource.id}`) return { ok: true };
    }
    return { ok: false, code: "FORBIDDEN", reason: "missing_permission" };
  }

  return {
    effective: load,
    async can(ctx, permission, resource) {
      return (await decide(ctx, permission, resource)).ok;
    },
    async require(ctx, permission, resource) {
      const d = await decide(ctx, permission, resource);
      if (d.ok) return;
      await audit.recordDetached(ctx, {
        action: "rbac.permission_denied",
        outcome: "denied",
        resourceType: resource?.type,
        resourceId: resource?.id,
        metadata: { permission, reason: d.reason },
      });
      throw new AppError(d.code, undefined, { permission });
    },
    async list(ctx) {
      const eff = await load(ctx);
      const keys = [...eff.orgWide];
      if (ctx.actor.isPlatformAdmin) keys.push("platform.admin");
      const enabled: string[] = [];
      for (const k of keys) {
        const def = registry.get(k);
        if (def && def.owner !== "core" && isModuleId(def.owner) && !(await entitlements?.isEnabled(ctx.organizationId, def.owner))) continue;
        enabled.push(k);
      }
      return enabled.sort();
    },
    registerActorResolver(actorType, resolver) {
      if (actorType === "user" || actorType === "system" || actorType === "api_key") throw new Error("Built-in actor types cannot be overridden");
      resolvers.set(actorType, resolver);
    },
    setEntitlements(checker) {
      entitlements = checker;
    },
  };
}
