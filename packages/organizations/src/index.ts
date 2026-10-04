import { resolveTxt } from "node:dns/promises";
import { z } from "zod";
import {
  and, desc, eq, ilike, inArray, invitations, isNull, memberRoles, memberships, organizationDomains, organizations, organizationSettings, or, roles, scopeOf, sessions, users,
  type DataRetentionSettings, type Database, type SecurityPolicySettings, type UsageLimitSettings,
} from "@eaop/db";
import { AuditActions, type AuditService } from "@eaop/audit";
import { type EventBus } from "@eaop/events";
import { type Authorizer, type RoleService } from "@eaop/rbac";
import { randomToken, sha256 } from "@eaop/security";
import { AppError, conflict, forbidden, notFound, SYSTEM_ACTOR, type PlatformContext, type TenantContext, type Uuid } from "@eaop/shared-types";

export const DEFAULT_SECURITY: SecurityPolicySettings = {
  mfaRequired: false,
  sessionIdleMinutes: 60,
  sessionMaxHours: 12,
  passwordMinLength: 12,
  allowedEmailDomains: [],
  ipAllowlist: [],
  ssoEnforced: false,
};
export const DEFAULT_RETENTION: DataRetentionSettings = {
  auditDays: 2555, // ~7 years
  aiPromptRetention: "metadata",
  aiRunDays: 365,
  notificationDays: 180,
  usageDays: 1095,
};

export const slugSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/, "3–48 lowercase letters, digits and hyphens");
const domainSchema = z.string().toLowerCase().regex(/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "Invalid domain");

export const createOrganizationSchema = z.object({
  name: z.string().min(2).max(160),
  slug: slugSchema,
  environment: z.enum(["production", "staging", "sandbox"]).default("production"),
  primaryDomain: domainSchema.optional(),
  adminUserId: z.string().uuid(),
});

export const securitySettingsSchema = z
  .object({
    mfaRequired: z.boolean(),
    sessionIdleMinutes: z.number().int().min(5).max(24 * 60),
    sessionMaxHours: z.number().int().min(1).max(24 * 30),
    passwordMinLength: z.number().int().min(12).max(128),
    allowedEmailDomains: z.array(domainSchema).max(50),
    ipAllowlist: z.array(z.string().max(64)).max(200),
    ssoEnforced: z.boolean(),
  })
  .partial();

export const retentionSettingsSchema = z
  .object({
    auditDays: z.number().int().min(90).max(3650),
    aiPromptRetention: z.enum(["none", "metadata", "full"]),
    aiRunDays: z.number().int().min(7).max(3650),
    notificationDays: z.number().int().min(7).max(3650),
    usageDays: z.number().int().min(30).max(3650),
  })
  .partial();

export const usageLimitsSchema = z.object({ monthlyAiCostUsd: z.number().positive().max(1e9).optional(), monthlyAiTokens: z.number().int().positive().optional() });

export interface OrganizationView {
  id: string;
  name: string;
  slug: string;
  status: string;
  environment: string;
  primaryDomain: string | null;
  plan: string;
  createdAt: string;
}

export interface MemberView {
  membershipId: string;
  userId: string;
  email: string;
  name: string;
  status: string;
  userStatus: string;
  title: string | null;
  department: string | null;
  source: string;
  lastLoginAt: string | null;
  mfaEnabled: boolean;
  roles: Array<{ id: string; key: string; name: string; scopeType: string | null; scopeId: string | null }>;
}

const orgView = (o: typeof organizations.$inferSelect): OrganizationView => ({
  id: o.id,
  name: o.name,
  slug: o.slug,
  status: o.status,
  environment: o.environment,
  primaryDomain: o.primaryDomain,
  plan: o.plan,
  createdAt: o.createdAt.toISOString(),
});

export interface OrganizationService {
  /** Provision a tenant. Platform admins, or the self-serve signup flow (system actor). */
  create(pctx: PlatformContext, input: z.input<typeof createOrganizationSchema>): Promise<OrganizationView>;
  listAll(pctx: PlatformContext): Promise<OrganizationView[]>;
  setStatus(pctx: PlatformContext, organizationId: Uuid, status: "active" | "suspended" | "archived"): Promise<OrganizationView>;
  get(ctx: TenantContext): Promise<OrganizationView>;
  update(ctx: TenantContext, input: { name?: string; primaryDomain?: string | null }): Promise<OrganizationView>;
  settings(ctx: TenantContext): Promise<{ security: SecurityPolicySettings; dataRetention: DataRetentionSettings; usageLimits: UsageLimitSettings }>;
  /** Unchecked settings read for internal enforcement (sessions, AI retention). */
  settingsInternal(organizationId: Uuid): Promise<{ security: SecurityPolicySettings; dataRetention: DataRetentionSettings; usageLimits: UsageLimitSettings }>;
  updateSecurity(ctx: TenantContext, patch: z.input<typeof securitySettingsSchema>): Promise<SecurityPolicySettings>;
  updateRetention(ctx: TenantContext, patch: z.input<typeof retentionSettingsSchema>): Promise<DataRetentionSettings>;
  updateUsageLimits(ctx: TenantContext, limits: z.input<typeof usageLimitsSchema>): Promise<UsageLimitSettings>;
  listDomains(ctx: TenantContext): Promise<Array<{ id: string; domain: string; verified: boolean; verificationRecord: string }>>;
  addDomain(ctx: TenantContext, domain: string): Promise<{ id: string; domain: string; verificationRecord: string; txtName: string }>;
  verifyDomain(ctx: TenantContext, domainId: Uuid): Promise<{ verified: boolean }>;
  listMembers(ctx: TenantContext, q?: { search?: string; status?: string }): Promise<MemberView[]>;
  setMemberStatus(ctx: TenantContext, membershipId: Uuid, status: "active" | "suspended" | "removed"): Promise<void>;
  invite(ctx: TenantContext, input: { email: string; roleKeys: string[] }): Promise<{ invitationId: string; token: string; expiresAt: string }>;
  listInvitations(ctx: TenantContext): Promise<Array<{ id: string; email: string; roleKeys: string[]; expiresAt: string; acceptedAt: string | null; revokedAt: string | null; createdAt: string }>>;
  revokeInvitation(ctx: TenantContext, invitationId: Uuid): Promise<void>;
  /** Organizations the user is an active member of (org switcher). */
  listForUser(userId: Uuid): Promise<Array<OrganizationView & { membershipId: string }>>;
}

export function createOrganizationService(deps: {
  db: Database;
  authorizer: Authorizer;
  roles: RoleService;
  audit: AuditService;
  bus: EventBus;
  resolveTxt?: (name: string) => Promise<string[][]>;
}): OrganizationService {
  const { db, authorizer, audit, bus } = deps;
  const txtLookup = deps.resolveTxt ?? resolveTxt;

  async function readSettings(organizationId: Uuid) {
    const [s] = await db.withTenant({ organizationId }, (tx) => tx.select().from(organizationSettings).where(eq(organizationSettings.organizationId, organizationId)).limit(1));
    return {
      security: { ...DEFAULT_SECURITY, ...(s?.security ?? {}) },
      dataRetention: { ...DEFAULT_RETENTION, ...(s?.dataRetention ?? {}) },
      usageLimits: s?.usageLimits ?? {},
    };
  }

  const isPlatform = (pctx: PlatformContext) => pctx.actor.isPlatformAdmin === true || pctx.actor.type === "system";

  return {
    async create(pctx, raw) {
      if (!isPlatform(pctx)) throw forbidden("Only platform administrators can provision organizations.");
      const input = createOrganizationSchema.parse(raw);
      const org = await db.withSystem("organizations.create", async (tx) => {
        const dup = await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, input.slug)).limit(1);
        if (dup[0]) throw conflict("That organization slug is taken.");
        const [admin] = await tx.select().from(users).where(eq(users.id, input.adminUserId)).limit(1);
        if (!admin) throw notFound("User", input.adminUserId);
        const [o] = await tx
          .insert(organizations)
          .values({ name: input.name, slug: input.slug, environment: input.environment, primaryDomain: input.primaryDomain ?? null })
          .returning();
        await tx.insert(organizationSettings).values({ organizationId: o!.id, security: DEFAULT_SECURITY, dataRetention: DEFAULT_RETENTION, usageLimits: {} });
        await tx.insert(memberships).values({ organizationId: o!.id, userId: admin.id, status: "active", source: "manual", joinedAt: new Date() });
        return o!;
      });
      const ctx: TenantContext = { organizationId: org.id, actor: pctx.actor, correlationId: pctx.correlationId, ip: pctx.ip, userAgent: pctx.userAgent };
      const sys: TenantContext = { ...ctx, actor: SYSTEM_ACTOR("organizations") };
      const [m] = await db.withTenant({ organizationId: org.id }, (tx) => tx.select().from(memberships).where(eq(memberships.organizationId, org.id)).limit(1));
      await deps.roles.grantInternal(sys, m!.id, "org_admin");
      await audit.record(ctx, { action: AuditActions.ORG_CREATED, resourceType: "organization", resourceId: org.id, after: { name: org.name, slug: org.slug, adminUserId: input.adminUserId } });
      await bus.publish(ctx, "organization.created", { organizationId: org.id, name: org.name, slug: org.slug });
      return orgView(org);
    },

    async listAll(pctx) {
      if (!pctx.actor.isPlatformAdmin) throw forbidden();
      const rows = await db.withSystem("organizations.list_all", (tx) => tx.select().from(organizations).orderBy(organizations.name));
      return rows.map(orgView);
    },

    async setStatus(pctx, organizationId, status) {
      if (!pctx.actor.isPlatformAdmin) throw forbidden();
      const [before] = await db.withSystem("organizations.status", (tx) => tx.select().from(organizations).where(eq(organizations.id, organizationId)).limit(1));
      if (!before) throw notFound("Organization", organizationId);
      const [o] = await db.withSystem("organizations.status", (tx) => tx.update(organizations).set({ status, updatedAt: new Date() }).where(eq(organizations.id, organizationId)).returning());
      const ctx: TenantContext = { organizationId, actor: pctx.actor, correlationId: pctx.correlationId, ip: pctx.ip, userAgent: pctx.userAgent };
      await audit.record(ctx, { action: AuditActions.ORG_STATUS_CHANGED, resourceType: "organization", resourceId: organizationId, before: { status: before.status }, after: { status } });
      await bus.publish(ctx, "organization.updated", { organizationId, fields: ["status"] });
      return orgView(o!);
    },

    async get(ctx) {
      await authorizer.require(ctx, "org.read");
      const [o] = await db.withTenant(scopeOf(ctx), (tx) => tx.select().from(organizations).where(eq(organizations.id, ctx.organizationId)).limit(1));
      if (!o) throw notFound("Organization");
      return orgView(o);
    },

    async update(ctx, input) {
      await authorizer.require(ctx, "org.manage");
      const data = z.object({ name: z.string().min(2).max(160).optional(), primaryDomain: domainSchema.nullable().optional() }).parse(input);
      return db.withTenant(scopeOf(ctx), async (tx) => {
        const [before] = await tx.select().from(organizations).where(eq(organizations.id, ctx.organizationId)).limit(1);
        const [o] = await tx.update(organizations).set({ ...data, updatedAt: new Date() }).where(eq(organizations.id, ctx.organizationId)).returning();
        await audit.record(ctx, { action: AuditActions.ORG_UPDATED, resourceType: "organization", resourceId: ctx.organizationId, before: { name: before?.name, primaryDomain: before?.primaryDomain }, after: data });
        await bus.publish(ctx, "organization.updated", { organizationId: ctx.organizationId, fields: Object.keys(data) });
        return orgView(o!);
      });
    },

    async settings(ctx) {
      await authorizer.require(ctx, "org.read");
      const s = await readSettings(ctx.organizationId);
      if (!(await authorizer.can(ctx, "org.security.read"))) {
        return { security: { ...s.security, ipAllowlist: [] }, dataRetention: s.dataRetention, usageLimits: s.usageLimits };
      }
      return s;
    },
    settingsInternal: readSettings,

    async updateSecurity(ctx, patch) {
      await authorizer.require(ctx, "org.security.manage");
      const data = securitySettingsSchema.parse(patch);
      const before = (await readSettings(ctx.organizationId)).security;
      const next = { ...before, ...data };
      await db.withTenant(scopeOf(ctx), async (tx) => {
        await tx.update(organizationSettings).set({ security: next, updatedAt: new Date() }).where(eq(organizationSettings.organizationId, ctx.organizationId));
        await audit.record(ctx, { action: AuditActions.SETTINGS_CHANGED, resourceType: "organization_settings", resourceId: ctx.organizationId, before: { security: before }, after: { security: next } });
      });
      return next;
    },

    async updateRetention(ctx, patch) {
      await authorizer.require(ctx, "org.security.manage");
      const data = retentionSettingsSchema.parse(patch);
      const before = (await readSettings(ctx.organizationId)).dataRetention;
      const next = { ...before, ...data };
      await db.withTenant(scopeOf(ctx), async (tx) => {
        await tx.update(organizationSettings).set({ dataRetention: next, updatedAt: new Date() }).where(eq(organizationSettings.organizationId, ctx.organizationId));
        await audit.record(ctx, { action: AuditActions.SETTINGS_CHANGED, resourceType: "organization_settings", resourceId: ctx.organizationId, before: { dataRetention: before }, after: { dataRetention: next } });
      });
      return next;
    },

    async updateUsageLimits(ctx, limits) {
      await authorizer.require(ctx, "org.manage");
      const data = usageLimitsSchema.parse(limits);
      const before = (await readSettings(ctx.organizationId)).usageLimits;
      await db.withTenant(scopeOf(ctx), async (tx) => {
        await tx.update(organizationSettings).set({ usageLimits: data, updatedAt: new Date() }).where(eq(organizationSettings.organizationId, ctx.organizationId));
        await audit.record(ctx, { action: AuditActions.SETTINGS_CHANGED, resourceType: "organization_settings", resourceId: ctx.organizationId, before: { usageLimits: before }, after: { usageLimits: data } });
      });
      return data;
    },

    async listDomains(ctx) {
      await authorizer.require(ctx, "org.read");
      const rows = await db.withTenant(scopeOf(ctx), (tx) => tx.select().from(organizationDomains).where(eq(organizationDomains.organizationId, ctx.organizationId)));
      return rows.map((d) => ({ id: d.id, domain: d.domain, verified: !!d.verifiedAt, verificationRecord: `eaop-verification=${d.verificationToken}` }));
    },

    async addDomain(ctx, domain) {
      await authorizer.require(ctx, "org.manage");
      const d = domainSchema.parse(domain);
      const token = randomToken(18);
      // Domain uniqueness is global; check in system scope without revealing the owning tenant.
      const taken = await db.withSystem("organizations.domain_unique", (tx) => tx.select({ id: organizationDomains.id }).from(organizationDomains).where(eq(organizationDomains.domain, d)).limit(1));
      if (taken[0]) throw conflict("That domain is already registered.");
      const [row] = await db.withTenant(scopeOf(ctx), (tx) => tx.insert(organizationDomains).values({ organizationId: ctx.organizationId, domain: d, verificationToken: token }).returning());
      await audit.record(ctx, { action: AuditActions.DOMAIN_ADDED, resourceType: "domain", resourceId: row!.id, after: { domain: d } });
      return { id: row!.id, domain: d, verificationRecord: `eaop-verification=${token}`, txtName: `_eaop-verification.${d}` };
    },

    async verifyDomain(ctx, domainId) {
      await authorizer.require(ctx, "org.manage");
      const [row] = await db.withTenant(scopeOf(ctx), (tx) => tx.select().from(organizationDomains).where(eq(organizationDomains.id, domainId)).limit(1));
      if (!row) throw notFound("Domain", domainId);
      if (row.verifiedAt) return { verified: true };
      let records: string[][] = [];
      try {
        records = await txtLookup(`_eaop-verification.${row.domain}`);
      } catch {
        records = [];
      }
      const ok = records.some((r) => r.join("") === `eaop-verification=${row.verificationToken}`);
      if (ok) {
        await db.withTenant(scopeOf(ctx), (tx) => tx.update(organizationDomains).set({ verifiedAt: new Date() }).where(eq(organizationDomains.id, domainId)));
        await audit.record(ctx, { action: AuditActions.DOMAIN_VERIFIED, resourceType: "domain", resourceId: domainId, after: { domain: row.domain } });
      }
      return { verified: ok };
    },

    async listMembers(ctx, q = {}) {
      await authorizer.require(ctx, "user.read");
      return db.withTenant(scopeOf(ctx), async (tx) => {
        const conds = [eq(memberships.organizationId, ctx.organizationId)];
        if (q.status) conds.push(eq(memberships.status, q.status as "active"));
        else conds.push(inArray(memberships.status, ["active", "suspended", "invited"]));
        if (q.search) {
          const like = `%${q.search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
          conds.push(or(ilike(users.email, like), ilike(users.name, like))!);
        }
        const rows = await tx
          .select({ m: memberships, u: { id: users.id, email: users.email, name: users.name, status: users.status, lastLoginAt: users.lastLoginAt, mfaEnabled: users.mfaEnabled } })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(and(...conds))
          .orderBy(users.name)
          .limit(1000);
        const roleRows = rows.length
          ? await tx
              .select({ membershipId: memberRoles.membershipId, id: memberRoles.id, key: roles.key, name: roles.name, scopeType: memberRoles.scopeType, scopeId: memberRoles.scopeId })
              .from(memberRoles)
              .innerJoin(roles, eq(roles.id, memberRoles.roleId))
              .where(inArray(memberRoles.membershipId, rows.map((r) => r.m.id)))
          : [];
        return rows.map(({ m, u }) => ({
          membershipId: m.id,
          userId: u.id,
          email: u.email,
          name: u.name,
          status: m.status,
          userStatus: u.status,
          title: m.title,
          department: m.department,
          source: m.source,
          lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
          mfaEnabled: u.mfaEnabled,
          roles: roleRows.filter((r) => r.membershipId === m.id).map(({ id, key, name, scopeType, scopeId }) => ({ id, key, name, scopeType, scopeId })),
        }));
      });
    },

    async setMemberStatus(ctx, membershipId, status) {
      await authorizer.require(ctx, "user.manage");
      await db.withTenant(scopeOf(ctx), async (tx) => {
        const [m] = await tx.select().from(memberships).where(and(eq(memberships.id, membershipId), eq(memberships.organizationId, ctx.organizationId))).limit(1);
        if (!m) throw notFound("Member", membershipId);
        if (ctx.actor.type === "user" && m.userId === ctx.actor.id) throw forbidden("You cannot change your own membership status.");
        if (status !== "active") {
          const admins = await tx
            .select({ membershipId: memberRoles.membershipId })
            .from(memberRoles)
            .innerJoin(roles, eq(roles.id, memberRoles.roleId))
            .innerJoin(memberships, eq(memberships.id, memberRoles.membershipId))
            .where(and(eq(roles.key, "org_admin"), eq(memberRoles.organizationId, ctx.organizationId), eq(memberships.status, "active"), isNull(memberRoles.scopeType)));
          if (admins.some((a) => a.membershipId === membershipId) && new Set(admins.map((a) => a.membershipId)).size <= 1) {
            throw conflict("An organization must keep at least one active administrator.");
          }
        }
        await tx.update(memberships).set({ status, updatedAt: new Date() }).where(eq(memberships.id, membershipId));
        if (status === "removed") await tx.delete(memberRoles).where(eq(memberRoles.membershipId, membershipId));
        const action = status === "active" ? AuditActions.MEMBER_REACTIVATED : status === "suspended" ? AuditActions.MEMBER_SUSPENDED : AuditActions.MEMBER_REMOVED;
        await audit.record(ctx, { action, resourceType: "membership", resourceId: membershipId, before: { status: m.status }, after: { status } });
        if (status === "suspended") await bus.publish(ctx, "user.suspended", { userId: m.userId, membershipId });
      });
      if (status !== "active") {
        // Sessions currently pointed at this tenant lose it immediately.
        const [m] = await db.withTenant(scopeOf(ctx), (tx) => tx.select({ userId: memberships.userId }).from(memberships).where(eq(memberships.id, membershipId)).limit(1));
        if (m) {
          await db.withSystem("organizations.member_sessions", (tx) =>
            tx.update(sessions).set({ activeOrganizationId: null }).where(and(eq(sessions.userId, m.userId), eq(sessions.activeOrganizationId, ctx.organizationId))),
          );
        }
      }
    },

    async invite(ctx, input) {
      await authorizer.require(ctx, "user.invite");
      const data = z.object({ email: z.string().email().max(320).toLowerCase(), roleKeys: z.array(z.string()).min(1).max(10) }).parse(input);
      const settings = await readSettings(ctx.organizationId);
      const domain = data.email.split("@")[1]!;
      if (settings.security.allowedEmailDomains.length && !settings.security.allowedEmailDomains.includes(domain)) {
        throw new AppError("VALIDATION_FAILED", "That email domain is not allowed by your organization's security policy.");
      }
      // Anti-escalation: inviter must hold every permission in the roles they hand out.
      const roleList = await deps.roles.listRoles({ ...ctx, actor: SYSTEM_ACTOR("organizations.invite") });
      const held = await authorizer.effective(ctx);
      for (const key of data.roleKeys) {
        const role = roleList.find((r) => r.key === key);
        if (!role) throw new AppError("VALIDATION_FAILED", `Unknown role "${key}".`);
        if (ctx.actor.type !== "system" && role.permissions.some((p) => !held.orgWide.has(p))) throw forbidden(`You cannot grant the "${role.name}" role.`);
      }
      const token = randomToken(32);
      const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
      return db.withTenant(scopeOf(ctx), async (tx) => {
        const existingMember = await tx
          .select({ id: memberships.id })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(and(eq(memberships.organizationId, ctx.organizationId), eq(memberships.status, "active"), ilike(users.email, data.email)))
          .limit(1);
        if (existingMember[0]) throw conflict("That user is already a member.");
        await tx
          .update(invitations)
          .set({ revokedAt: new Date() })
          .where(and(eq(invitations.organizationId, ctx.organizationId), eq(invitations.email, data.email), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
        const [inv] = await tx
          .insert(invitations)
          .values({ organizationId: ctx.organizationId, email: data.email, roleKeys: data.roleKeys, tokenHash: sha256(token), invitedBy: ctx.actor.type === "user" ? ctx.actor.id : null, expiresAt })
          .returning();
        await audit.record(ctx, { action: AuditActions.USER_INVITED, resourceType: "invitation", resourceId: inv!.id, after: { email: data.email, roleKeys: data.roleKeys } });
        await bus.publish(ctx, "user.invited", { invitationId: inv!.id, email: data.email, roleKeys: data.roleKeys });
        return { invitationId: inv!.id, token, expiresAt: expiresAt.toISOString() };
      });
    },

    async listInvitations(ctx) {
      await authorizer.require(ctx, "user.read");
      const rows = await db.withTenant(scopeOf(ctx), (tx) => tx.select().from(invitations).where(eq(invitations.organizationId, ctx.organizationId)).orderBy(desc(invitations.createdAt)).limit(500));
      return rows.map((r) => ({ id: r.id, email: r.email, roleKeys: r.roleKeys, expiresAt: r.expiresAt.toISOString(), acceptedAt: r.acceptedAt?.toISOString() ?? null, revokedAt: r.revokedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString() }));
    },

    async revokeInvitation(ctx, invitationId) {
      await authorizer.require(ctx, "user.invite");
      const [row] = await db.withTenant(scopeOf(ctx), (tx) =>
        tx.update(invitations).set({ revokedAt: new Date() }).where(and(eq(invitations.id, invitationId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt))).returning(),
      );
      if (!row) throw notFound("Invitation", invitationId);
      await audit.record(ctx, { action: AuditActions.INVITATION_REVOKED, resourceType: "invitation", resourceId: invitationId });
    },

    async listForUser(userId) {
      const rows = await db.withUser(userId, (tx) =>
        tx
          .select({ o: organizations, membershipId: memberships.id })
          .from(memberships)
          .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
          .where(and(eq(memberships.userId, userId), eq(memberships.status, "active")))
          .orderBy(organizations.name),
      );
      return rows.map((r) => ({ ...orgView(r.o), membershipId: r.membershipId }));
    },
  };
}
