import { z } from "zod";
import { and, eq, inArray, isNull, memberRoles, memberships, or, permissions, rolePermissions, roles, scopeOf, sql, type Database } from "@eaop/db";
import { AuditActions, type AuditService } from "@eaop/audit";
import { type EventBus } from "@eaop/events";
import { AppError, conflict, forbidden, notFound, type TenantContext } from "@eaop/shared-types";
import { type Authorizer } from "./authorizer";
import { type PermissionRegistry } from "./permissions";
import { SOD_CONSTRAINTS, SYSTEM_ROLES, type SystemRoleDefinition } from "./roles";

export const roleKeySchema = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/, "lowercase letters, digits and underscores");
export const createRoleSchema = z.object({
  key: roleKeySchema,
  name: z.string().min(1).max(120),
  description: z.string().max(500).default(""),
  permissions: z.array(z.string()).max(500),
});
export const assignRoleSchema = z.object({
  membershipId: z.string().uuid(),
  roleKey: roleKeySchema,
  scopeType: z.enum(["module", "resource"]).optional(),
  scopeId: z.string().max(200).optional(),
});

export interface RoleView {
  id: string;
  key: string;
  name: string;
  description: string;
  isSystem: boolean;
  permissions: string[];
}

export interface MemberRoleView {
  id: string;
  membershipId: string;
  roleKey: string;
  roleName: string;
  scopeType: string | null;
  scopeId: string | null;
}

export interface RoleService {
  /** Upsert permission catalog + system roles from code registrations (system scope, boot time). */
  syncCatalog(): Promise<void>;
  listRoles(ctx: TenantContext): Promise<RoleView[]>;
  createRole(ctx: TenantContext, input: z.input<typeof createRoleSchema>): Promise<RoleView>;
  updateRolePermissions(ctx: TenantContext, roleKey: string, permissionKeys: string[]): Promise<RoleView>;
  deleteRole(ctx: TenantContext, roleKey: string): Promise<void>;
  assign(ctx: TenantContext, input: z.input<typeof assignRoleSchema>): Promise<MemberRoleView>;
  revoke(ctx: TenantContext, memberRoleId: string): Promise<void>;
  memberRoles(ctx: TenantContext, membershipId: string): Promise<MemberRoleView[]>;
  /** Internal: grant a role without actor checks (org provisioning, invitation acceptance). */
  grantInternal(ctx: TenantContext, membershipId: string, roleKey: string): Promise<void>;
}

export function createRoleService(deps: {
  db: Database;
  registry: PermissionRegistry;
  authorizer: Authorizer;
  audit: AuditService;
  bus: EventBus;
  /** Additional permission patterns granted to system roles by installed modules. */
  extraRoleGrants?: () => Record<string, string[]>;
}): RoleService {
  const { db, registry, authorizer, audit, bus } = deps;

  async function roleByKey(ctx: TenantContext, key: string) {
    return db.withTenant(scopeOf(ctx), async (tx) => {
      const rows = await tx
        .select()
        .from(roles)
        .where(and(eq(roles.key, key), or(isNull(roles.organizationId), eq(roles.organizationId, ctx.organizationId))));
      // Tenant custom roles shadow nothing: system keys are reserved (see createRole).
      return rows[0];
    });
  }

  async function permsOf(ctx: TenantContext, roleIds: string[]) {
    if (roleIds.length === 0) return new Map<string, string[]>();
    const rows = await db.withTenant(scopeOf(ctx), (tx) => tx.select().from(rolePermissions).where(inArray(rolePermissions.roleId, roleIds)));
    const map = new Map<string, string[]>();
    for (const r of rows) map.set(r.roleId, [...(map.get(r.roleId) ?? []), r.permissionKey]);
    return map;
  }

  /** Anti-escalation: an actor may only grant permissions they themselves hold. */
  async function assertCanGrant(ctx: TenantContext, perms: string[]) {
    if (ctx.actor.type === "system") return;
    const held = await authorizer.effective(ctx);
    const missing = perms.filter((p) => !held.orgWide.has(p));
    if (missing.length) throw forbidden("You cannot grant permissions you do not hold.", { missing: missing.slice(0, 20) });
  }

  const SYSTEM_KEYS = new Set(SYSTEM_ROLES.map((r) => r.key));

  return {
    async syncCatalog() {
      await db.withSystem("rbac.sync_catalog", async (tx) => {
        // Instances booting concurrently must not interleave the delete/insert below.
        await tx.execute(sql`select pg_advisory_xact_lock(${db.lockKey("rbac.sync_catalog")})`);
        for (const p of registry.list()) {
          await tx
            .insert(permissions)
            .values({ key: p.key, owner: p.owner, description: p.description, risk: p.risk })
            .onConflictDoUpdate({ target: permissions.key, set: { owner: p.owner, description: p.description, risk: p.risk } });
        }
        for (const def of SYSTEM_ROLES as SystemRoleDefinition[]) {
          const existing = await tx.select().from(roles).where(and(isNull(roles.organizationId), eq(roles.key, def.key))).limit(1);
          const roleId =
            existing[0]?.id ??
            (await tx.insert(roles).values({ organizationId: null, key: def.key, name: def.name, description: def.description, isSystem: true }).returning())[0]!.id;
          if (existing[0]) await tx.update(roles).set({ name: def.name, description: def.description, updatedAt: new Date() }).where(eq(roles.id, roleId));
          const expanded = registry.expand([...def.permissions, ...(deps.extraRoleGrants?.()[def.key] ?? [])]);
          await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
          if (expanded.length) await tx.insert(rolePermissions).values(expanded.map((k) => ({ roleId, permissionKey: k })));
        }
      });
    },

    async listRoles(ctx) {
      await authorizer.require(ctx, "role.read");
      const rows = await db.withTenant(scopeOf(ctx), (tx) =>
        tx.select().from(roles).where(or(isNull(roles.organizationId), eq(roles.organizationId, ctx.organizationId))),
      );
      const visible = rows.filter((r) => r.key !== "platform_admin");
      const perms = await permsOf(ctx, visible.map((r) => r.id));
      return visible
        .map((r) => ({ id: r.id, key: r.key, name: r.name, description: r.description, isSystem: r.isSystem, permissions: (perms.get(r.id) ?? []).sort() }))
        .sort((a, b) => Number(b.isSystem) - Number(a.isSystem) || a.name.localeCompare(b.name));
    },

    async createRole(ctx, input) {
      await authorizer.require(ctx, "role.manage");
      const data = createRoleSchema.parse(input);
      if (SYSTEM_KEYS.has(data.key as never)) throw conflict("That key is reserved for a system role.");
      for (const p of data.permissions) if (!registry.has(p)) throw new AppError("VALIDATION_FAILED", `Unknown permission "${p}".`);
      if (data.permissions.includes("platform.admin")) throw forbidden("platform.admin cannot be granted to tenant roles.");
      await assertCanGrant(ctx, data.permissions);
      return db.withTenant(scopeOf(ctx), async (tx) => {
        const dup = await tx.select().from(roles).where(and(eq(roles.organizationId, ctx.organizationId), eq(roles.key, data.key))).limit(1);
        if (dup[0]) throw conflict("A role with that key already exists.");
        const [role] = await tx.insert(roles).values({ organizationId: ctx.organizationId, key: data.key, name: data.name, description: data.description }).returning();
        if (data.permissions.length) await tx.insert(rolePermissions).values(data.permissions.map((k) => ({ roleId: role!.id, permissionKey: k })));
        await audit.record(ctx, { action: AuditActions.ROLE_CREATED, resourceType: "role", resourceId: role!.id, after: data });
        return { id: role!.id, key: role!.key, name: role!.name, description: role!.description, isSystem: false, permissions: [...data.permissions].sort() };
      });
    },

    async updateRolePermissions(ctx, roleKey, permissionKeys) {
      await authorizer.require(ctx, "role.manage");
      const role = await roleByKey(ctx, roleKey);
      if (!role) throw notFound("Role", roleKey);
      if (role.isSystem || role.organizationId === null) throw forbidden("System roles are managed by the platform and cannot be edited.");
      for (const p of permissionKeys) if (!registry.has(p) || p === "platform.admin") throw new AppError("VALIDATION_FAILED", `Invalid permission "${p}".`);
      await assertCanGrant(ctx, permissionKeys);
      const before = (await permsOf(ctx, [role.id])).get(role.id) ?? [];
      return db.withTenant(scopeOf(ctx), async (tx) => {
        await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, role.id));
        if (permissionKeys.length) await tx.insert(rolePermissions).values([...new Set(permissionKeys)].map((k) => ({ roleId: role.id, permissionKey: k })));
        await audit.record(ctx, { action: AuditActions.ROLE_UPDATED, resourceType: "role", resourceId: role.id, before: { permissions: before }, after: { permissions: permissionKeys } });
        return { id: role.id, key: role.key, name: role.name, description: role.description, isSystem: false, permissions: [...new Set(permissionKeys)].sort() };
      });
    },

    async deleteRole(ctx, roleKey) {
      await authorizer.require(ctx, "role.manage");
      const role = await roleByKey(ctx, roleKey);
      if (!role) throw notFound("Role", roleKey);
      if (role.isSystem || role.organizationId === null) throw forbidden("System roles cannot be deleted.");
      await db.withTenant(scopeOf(ctx), async (tx) => {
        await tx.delete(roles).where(eq(roles.id, role.id));
        await audit.record(ctx, { action: AuditActions.ROLE_DELETED, resourceType: "role", resourceId: role.id, before: { key: role.key } });
      });
    },

    async assign(ctx, input) {
      await authorizer.require(ctx, "role.manage");
      const data = assignRoleSchema.parse(input);
      if ((data.scopeType && !data.scopeId) || (!data.scopeType && data.scopeId)) throw new AppError("VALIDATION_FAILED", "scopeType and scopeId must be provided together.");
      const role = await roleByKey(ctx, data.roleKey);
      if (!role || role.key === "platform_admin") throw notFound("Role", data.roleKey);
      const rolePerms = (await permsOf(ctx, [role.id])).get(role.id) ?? [];
      await assertCanGrant(ctx, rolePerms);
      return db.withTenant(scopeOf(ctx), async (tx) => {
        const [m] = await tx.select().from(memberships).where(and(eq(memberships.id, data.membershipId), eq(memberships.organizationId, ctx.organizationId))).limit(1);
        if (!m) throw notFound("Membership", data.membershipId);
        if (ctx.actor.type === "user" && m.userId === ctx.actor.id) throw forbidden("You cannot change your own roles.");
        // Separation of duties.
        const current = await tx
          .select({ key: roles.key })
          .from(memberRoles)
          .innerJoin(roles, eq(roles.id, memberRoles.roleId))
          .where(eq(memberRoles.membershipId, m.id));
        for (const c of SOD_CONSTRAINTS) {
          const has = (k: string) => current.some((r) => r.key === k);
          if ((role.key === c.a && has(c.b)) || (role.key === c.b && has(c.a))) throw conflict(`Separation of duties: ${c.reason}`);
        }
        const [row] = await tx
          .insert(memberRoles)
          .values({ organizationId: ctx.organizationId, membershipId: m.id, roleId: role.id, scopeType: data.scopeType ?? null, scopeId: data.scopeId ?? null, grantedBy: ctx.actor.type === "user" ? ctx.actor.id : null })
          .onConflictDoNothing()
          .returning();
        if (!row) throw conflict("The member already has this role assignment.");
        await audit.record(ctx, { action: AuditActions.ROLE_ASSIGNED, resourceType: "membership", resourceId: m.id, after: { roleKey: role.key, scopeType: data.scopeType ?? null, scopeId: data.scopeId ?? null } });
        await bus.publish(ctx, "role.assigned", { membershipId: m.id, roleKey: role.key, scopeType: data.scopeType ?? null, scopeId: data.scopeId ?? null });
        return { id: row.id, membershipId: m.id, roleKey: role.key, roleName: role.name, scopeType: row.scopeType, scopeId: row.scopeId };
      });
    },

    async revoke(ctx, memberRoleId) {
      await authorizer.require(ctx, "role.manage");
      await db.withTenant(scopeOf(ctx), async (tx) => {
        const [row] = await tx
          .select({ id: memberRoles.id, membershipId: memberRoles.membershipId, roleKey: roles.key, userId: memberships.userId })
          .from(memberRoles)
          .innerJoin(roles, eq(roles.id, memberRoles.roleId))
          .innerJoin(memberships, eq(memberships.id, memberRoles.membershipId))
          .where(and(eq(memberRoles.id, memberRoleId), eq(memberRoles.organizationId, ctx.organizationId)))
          .limit(1);
        if (!row) throw notFound("Role assignment", memberRoleId);
        if (ctx.actor.type === "user" && row.userId === ctx.actor.id) throw forbidden("You cannot change your own roles.");
        if (row.roleKey === "org_admin") {
          const admins = await tx
            .select({ id: memberRoles.id })
            .from(memberRoles)
            .innerJoin(roles, eq(roles.id, memberRoles.roleId))
            .innerJoin(memberships, eq(memberships.id, memberRoles.membershipId))
            .where(and(eq(roles.key, "org_admin"), eq(memberRoles.organizationId, ctx.organizationId), eq(memberships.status, "active"), isNull(memberRoles.scopeType)));
          if (admins.length <= 1) throw conflict("An organization must keep at least one administrator.");
        }
        await tx.delete(memberRoles).where(eq(memberRoles.id, memberRoleId));
        await audit.record(ctx, { action: AuditActions.ROLE_REVOKED, resourceType: "membership", resourceId: row.membershipId, before: { roleKey: row.roleKey } });
        await bus.publish(ctx, "role.revoked", { membershipId: row.membershipId, roleKey: row.roleKey });
      });
    },

    async memberRoles(ctx, membershipId) {
      await authorizer.require(ctx, "role.read");
      const rows = await db.withTenant(scopeOf(ctx), (tx) =>
        tx
          .select({ id: memberRoles.id, membershipId: memberRoles.membershipId, roleKey: roles.key, roleName: roles.name, scopeType: memberRoles.scopeType, scopeId: memberRoles.scopeId })
          .from(memberRoles)
          .innerJoin(roles, eq(roles.id, memberRoles.roleId))
          .where(and(eq(memberRoles.membershipId, membershipId), eq(memberRoles.organizationId, ctx.organizationId))),
      );
      return rows;
    },

    async grantInternal(ctx, membershipId, roleKey) {
      const role = await roleByKey(ctx, roleKey);
      if (!role || role.key === "platform_admin") throw notFound("Role", roleKey);
      await db.withTenant(scopeOf(ctx), async (tx) => {
        // Separation of duties is enforced on EVERY grant path, not only assign():
        // invitation acceptance and SSO JIT also flow through here.
        const current = await tx.select({ key: roles.key }).from(memberRoles).innerJoin(roles, eq(roles.id, memberRoles.roleId)).where(eq(memberRoles.membershipId, membershipId));
        for (const c of SOD_CONSTRAINTS) {
          const has = (k: string) => current.some((r) => r.key === k);
          if ((role.key === c.a && has(c.b)) || (role.key === c.b && has(c.a))) throw conflict(`Separation of duties: ${c.reason}`);
        }
        await tx.insert(memberRoles).values({ organizationId: ctx.organizationId, membershipId, roleId: role.id }).onConflictDoNothing();
      });
    },
  };
}

