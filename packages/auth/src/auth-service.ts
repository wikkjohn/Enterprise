import { z } from "zod";
import { and, eq, gt, invitations, isNull, memberships, organizations, sql, users, authTokens, type Database } from "@eaop/db";
import { AuditActions, type AuditService } from "@eaop/audit";
import { type EventBus } from "@eaop/events";
import { type EmailSender, type NotificationService } from "@eaop/notifications";
import { type Logger } from "@eaop/observability";
import { DEFAULT_SECURITY, type OrganizationService } from "@eaop/organizations";
import { type RoleService } from "@eaop/rbac";
import { type SecretStore } from "@eaop/secrets";
import {
  checkPasswordPolicy, dummyPasswordHash, generateTotpSecret, hashPassword, ipAllowed, randomToken, sha256, totpUri, verifyPassword, verifyTotp,
} from "@eaop/security";
import { AppError, SYSTEM_ACTOR, type Actor, type RequestMeta, type TenantContext, type Uuid } from "@eaop/shared-types";
import { type SessionManager, type SessionRecord, type SessionUser } from "./sessions";

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;
const GENERIC_LOGIN_ERROR = "Invalid email or password.";

export const loginSchema = z.object({ email: z.string().email().max(320), password: z.string().min(1).max(256) });
export const acceptInvitationSchema = z.object({ token: z.string().min(20).max(128), name: z.string().min(1).max(160), password: z.string().min(1).max(256) });

export interface AuthConfig {
  appUrl: string;
  environment: string;
  allowSelfServeSignup: boolean;
  issuerName: string;
}

export type LoginResult =
  | { status: "ok"; token: string; session: SessionRecord; user: SessionUser }
  | { status: "mfa_required"; token: string; session: SessionRecord; user: SessionUser };

export interface ResolvedRequest {
  user: SessionUser;
  session: SessionRecord;
  /** Null when the user has no active organization (e.g. all memberships suspended). */
  tenant: TenantContext | null;
  /** The org requires MFA and the user has not enrolled: only MFA enrollment is allowed. */
  mfaEnrollmentRequired: boolean;
}

export interface AuthService {
  login(input: z.input<typeof loginSchema>, meta: RequestMeta): Promise<LoginResult>;
  verifyMfa(token: string, code: string, meta: RequestMeta): Promise<void>;
  logout(token: string, meta: RequestMeta): Promise<void>;
  resolve(token: string, meta: RequestMeta): Promise<ResolvedRequest | null>;
  switchOrganization(token: string, organizationId: Uuid, meta: RequestMeta): Promise<void>;
  acceptInvitation(input: z.input<typeof acceptInvitationSchema>, meta: RequestMeta): Promise<LoginResult>;
  describeInvitation(token: string): Promise<{ email: string; organizationName: string; userExists: boolean } | null>;
  /** Self-serve signup (disabled unless allowSelfServeSignup). Creates a user + an organization. */
  signup(input: { email: string; name: string; password: string; organizationName: string; organizationSlug: string }, meta: RequestMeta): Promise<LoginResult>;
  /** Create the first platform administrator. Fails if one already exists. */
  bootstrapPlatformAdmin(input: { email: string; name: string; password: string }): Promise<Uuid>;
  changePassword(userId: Uuid, sessionId: Uuid, current: string, next: string, meta: RequestMeta): Promise<void>;
  requestPasswordReset(email: string, meta: RequestMeta): Promise<void>;
  resetPassword(token: string, password: string, meta: RequestMeta): Promise<void>;
  beginMfaEnrollment(userId: Uuid): Promise<{ secret: string; otpauthUri: string }>;
  confirmMfaEnrollment(userId: Uuid, code: string, meta: RequestMeta): Promise<void>;
  disableMfa(userId: Uuid, code: string, meta: RequestMeta): Promise<void>;
  listSessions(userId: Uuid): ReturnType<SessionManager["listForUser"]>;
  revokeSession(userId: Uuid, sessionId: Uuid, meta: RequestMeta): Promise<void>;
  /** Used by SSO after the IdP has authenticated the user. */
  createSessionForUser(userId: Uuid, organizationId: Uuid, method: "oidc" | "saml", meta: RequestMeta): Promise<{ token: string; session: SessionRecord }>;
}

export function createAuthService(deps: {
  db: Database;
  sessions: SessionManager;
  organizations: OrganizationService;
  roles: RoleService;
  audit: AuditService;
  bus: EventBus;
  secrets: SecretStore;
  notifications: NotificationService;
  email: EmailSender;
  logger: Logger;
  config: AuthConfig;
}): AuthService {
  const { db, sessions, organizations: orgs, audit, bus, secrets } = deps;

  const userActor = (u: { id: string; email: string; isPlatformAdmin?: boolean }): Actor => ({ type: "user", id: u.id, label: u.email, isPlatformAdmin: u.isPlatformAdmin });
  const tctx = (organizationId: Uuid, actor: Actor, meta: RequestMeta): TenantContext => ({ organizationId, actor, ...meta, cache: new Map() });

  async function findUserByEmail(email: string) {
    const [u] = await db.withSystem("auth.find_user", (tx) => tx.select().from(users).where(sql`lower(${users.email}) = ${email.toLowerCase()}`).limit(1));
    return u;
  }

  async function defaultOrg(userId: Uuid): Promise<Uuid | null> {
    const list = await orgs.listForUser(userId);
    return list.find((o) => o.status === "active")?.id ?? null;
  }

  async function auditFor(userId: Uuid, orgId: Uuid | null, actor: Actor, meta: RequestMeta, input: Parameters<AuditService["record"]>[1]) {
    if (orgId) await audit.recordDetached(tctx(orgId, actor, meta), input);
    else await audit.recordPlatform({ actorType: actor.type, actorId: actor.id, actorLabel: actor.label, ip: meta.ip, userAgent: meta.userAgent, correlationId: meta.correlationId }, input);
  }

  async function startSession(user: typeof users.$inferSelect, method: "password" | "oidc" | "saml", meta: RequestMeta, forcedOrg?: Uuid): Promise<LoginResult> {
    const orgId = forcedOrg ?? (await defaultOrg(user.id));
    const security = orgId ? (await orgs.settingsInternal(orgId)).security : DEFAULT_SECURITY;
    const mfaPending = method === "password" && user.mfaEnabled;
    const { token, session } = await sessions.create({ userId: user.id, activeOrganizationId: orgId, authMethod: method, mfaPending, ip: meta.ip, userAgent: meta.userAgent, maxHours: security.sessionMaxHours });
    await db.withSystem("auth.last_login", (tx) => tx.update(users).set({ lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, user.id)));
    if (!mfaPending) await auditFor(user.id, orgId, userActor(user), meta, { action: AuditActions.LOGIN, metadata: { method, sessionId: session.id } });
    const su: SessionUser = { id: user.id, email: user.email, name: user.name, status: user.status, isPlatformAdmin: user.isPlatformAdmin, mfaEnabled: user.mfaEnabled };
    return { status: mfaPending ? "mfa_required" : "ok", token, session, user: su };
  }

  async function grantRoles(orgId: Uuid, membershipId: Uuid, roleKeys: string[]) {
    const sys = tctx(orgId, SYSTEM_ACTOR("auth.invitations"), { correlationId: "internal" });
    for (const k of roleKeys) await deps.roles.grantInternal(sys, membershipId, k);
  }

  return {
    async login(raw, meta) {
      const input = loginSchema.parse(raw);
      const user = await findUserByEmail(input.email);
      if (!user || !user.passwordHash) {
        await verifyPassword(input.password, await dummyPasswordHash()); // equalise timing
        await audit.recordPlatform({ actorType: "anonymous", actorId: "unknown", actorLabel: input.email.toLowerCase().slice(0, 320), ip: meta.ip, userAgent: meta.userAgent, correlationId: meta.correlationId }, { action: AuditActions.LOGIN_FAILED, outcome: "failure", metadata: { reason: "unknown_user_or_sso_only" } });
        throw new AppError("UNAUTHENTICATED", GENERIC_LOGIN_ERROR);
      }
      if (user.lockedUntil && user.lockedUntil > new Date()) {
        await auditFor(user.id, await defaultOrg(user.id), userActor(user), meta, { action: AuditActions.LOGIN_FAILED, outcome: "denied", metadata: { reason: "locked" } });
        throw new AppError("UNAUTHENTICATED", "Account temporarily locked after repeated failed sign-ins. Try again later.");
      }
      const ok = await verifyPassword(input.password, user.passwordHash);
      if (!ok || user.status !== "active") {
        const failures = user.failedLoginCount + 1;
        await db.withSystem("auth.failed_login", (tx) =>
          tx
            .update(users)
            .set({ failedLoginCount: failures, lockedUntil: failures >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null })
            .where(eq(users.id, user.id)),
        );
        await auditFor(user.id, await defaultOrg(user.id), userActor(user), meta, { action: AuditActions.LOGIN_FAILED, outcome: "failure", metadata: { reason: ok ? `user_${user.status}` : "bad_password", failures } });
        throw new AppError("UNAUTHENTICATED", GENERIC_LOGIN_ERROR);
      }
      const orgId = await defaultOrg(user.id);
      if (orgId) {
        const sec = (await orgs.settingsInternal(orgId)).security;
        if (sec.ssoEnforced && !user.isPlatformAdmin) throw new AppError("FORBIDDEN", "Your organization requires single sign-on.");
        if (!ipAllowed(meta.ip, sec.ipAllowlist)) {
          await auditFor(user.id, orgId, userActor(user), meta, { action: AuditActions.LOGIN_FAILED, outcome: "denied", metadata: { reason: "ip_not_allowed" } });
          throw new AppError("FORBIDDEN", "Sign-in is not allowed from this network.");
        }
      }
      return startSession(user, "password", meta);
    },

    async verifyMfa(token, code, meta) {
      const v = await sessions.validate(token, async () => 15);
      if (!v || !v.session.mfaPending) throw new AppError("UNAUTHENTICATED");
      const [u] = await db.withSystem("auth.mfa_lookup", (tx) => tx.select().from(users).where(eq(users.id, v.user.id)).limit(1));
      if (!u?.mfaSecretRef || !u.mfaEnabled) throw new AppError("UNAUTHENTICATED");
      const secret = await secrets.get(u.mfaSecretRef, null);
      if (!verifyTotp(secret, code)) {
        await auditFor(u.id, v.session.activeOrganizationId, userActor(u), meta, { action: AuditActions.LOGIN_FAILED, outcome: "failure", metadata: { reason: "bad_mfa_code" } });
        throw new AppError("UNAUTHENTICATED", "Invalid verification code.");
      }
      await sessions.completeMfa(v.session.id);
      await auditFor(u.id, v.session.activeOrganizationId, userActor(u), meta, { action: AuditActions.LOGIN, metadata: { method: "password+totp", sessionId: v.session.id } });
    },

    async logout(token, meta) {
      const v = await sessions.validate(token, async () => 24 * 60);
      if (!v) return;
      await sessions.revoke(v.session.id, "logout");
      await auditFor(v.user.id, v.session.activeOrganizationId, userActor(v.user), meta, { action: AuditActions.LOGOUT, metadata: { sessionId: v.session.id } });
    },

    async resolve(token, meta) {
      const v = await sessions.validate(token, async (orgId) => (orgId ? (await orgs.settingsInternal(orgId)).security.sessionIdleMinutes : DEFAULT_SECURITY.sessionIdleMinutes));
      if (!v || v.session.mfaPending) return null;
      const actor = userActor(v.user);
      let orgId = v.session.activeOrganizationId;
      // Re-validate membership on every request: suspension/removal takes effect immediately.
      const memberOf = await orgs.listForUser(v.user.id);
      if (!orgId || !memberOf.some((o) => o.id === orgId && o.status === "active")) {
        orgId = memberOf.find((o) => o.status === "active")?.id ?? null;
        await sessions.setActiveOrganization(v.session.id, orgId);
      }
      if (!orgId) return { user: v.user, session: v.session, tenant: null, mfaEnrollmentRequired: false };
      const sec = (await orgs.settingsInternal(orgId)).security;
      if (!ipAllowed(meta.ip, sec.ipAllowlist)) throw new AppError("FORBIDDEN", "Access is not allowed from this network.");
      return {
        user: v.user,
        session: v.session,
        tenant: { ...tctx(orgId, actor, meta), sessionId: v.session.id },
        mfaEnrollmentRequired: sec.mfaRequired && !v.user.mfaEnabled,
      };
    },

    async switchOrganization(token, organizationId, meta) {
      const v = await sessions.validate(token, async () => 24 * 60);
      if (!v || v.session.mfaPending) throw new AppError("UNAUTHENTICATED");
      const memberOf = await orgs.listForUser(v.user.id);
      const target = memberOf.find((o) => o.id === organizationId && o.status === "active");
      // Same error whether the org does not exist or the user is not a member: no tenant enumeration.
      if (!target) throw new AppError("NOT_FOUND", "Organization not found.");
      await sessions.setActiveOrganization(v.session.id, organizationId);
      await audit.record(tctx(organizationId, userActor(v.user), meta), { action: AuditActions.ORG_SWITCHED, metadata: { from: v.session.activeOrganizationId } });
    },

    async describeInvitation(token) {
      const [inv] = await db.withSystem("auth.describe_invitation", (tx) =>
        tx
          .select({ email: invitations.email, orgName: organizations.name })
          .from(invitations)
          .innerJoin(organizations, eq(organizations.id, invitations.organizationId))
          .where(and(eq(invitations.tokenHash, sha256(token)), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date())))
          .limit(1),
      );
      if (!inv) return null;
      return { email: inv.email, organizationName: inv.orgName, userExists: !!(await findUserByEmail(inv.email)) };
    },

    async acceptInvitation(raw, meta) {
      const input = acceptInvitationSchema.parse(raw);
      const [inv] = await db.withSystem("auth.accept_invitation", (tx) =>
        tx
          .select()
          .from(invitations)
          .where(and(eq(invitations.tokenHash, sha256(input.token)), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date())))
          .limit(1),
      );
      if (!inv) throw new AppError("NOT_FOUND", "This invitation is invalid or has expired.");
      const security = (await orgs.settingsInternal(inv.organizationId)).security;
      let user = await findUserByEmail(inv.email);
      if (user) {
        // Existing account: prove ownership with its password.
        if (!user.passwordHash || !(await verifyPassword(input.password, user.passwordHash))) throw new AppError("UNAUTHENTICATED", GENERIC_LOGIN_ERROR);
      } else {
        const problems = checkPasswordPolicy(input.password, { minLength: security.passwordMinLength }, { email: inv.email });
        if (problems.length) throw new AppError("VALIDATION_FAILED", problems[0], { problems });
        const hash = await hashPassword(input.password);
        [user] = await db.withSystem("auth.create_user", (tx) => tx.insert(users).values({ email: inv.email, name: input.name, passwordHash: hash, status: "active" }).returning());
      }
      const u = user!;
      const membershipId = await db.withSystem("auth.accept_membership", async (tx) => {
        await tx.update(invitations).set({ acceptedAt: new Date() }).where(eq(invitations.id, inv.id));
        const [m] = await tx
          .insert(memberships)
          .values({ organizationId: inv.organizationId, userId: u.id, status: "active", source: "invitation", joinedAt: new Date() })
          .onConflictDoUpdate({ target: [memberships.organizationId, memberships.userId], set: { status: "active", joinedAt: new Date(), updatedAt: new Date() } })
          .returning({ id: memberships.id });
        return m!.id;
      });
      await grantRoles(inv.organizationId, membershipId, inv.roleKeys);
      const ctx = tctx(inv.organizationId, userActor(u), meta);
      await audit.record(ctx, { action: AuditActions.INVITATION_ACCEPTED, resourceType: "invitation", resourceId: inv.id, after: { membershipId, roleKeys: inv.roleKeys } });
      await bus.publish(ctx, "user.joined", { userId: u.id, membershipId, source: "invitation" });
      if (inv.invitedBy) {
        await deps.notifications.notify({ ...ctx, actor: SYSTEM_ACTOR("auth") }, { type: "core.invitation_accepted", title: `${u.name} joined your organization`, actionUrl: "/admin/users", recipients: { userIds: [inv.invitedBy] } });
      }
      return startSession(u, "password", meta, inv.organizationId);
    },

    async signup(input, meta) {
      if (!deps.config.allowSelfServeSignup) throw new AppError("FORBIDDEN", "Self-service signup is disabled. Ask your administrator for an invitation.");
      const data = z
        .object({ email: z.string().email().max(320).toLowerCase(), name: z.string().min(1).max(160), password: z.string().max(256), organizationName: z.string().min(2).max(160), organizationSlug: z.string() })
        .parse(input);
      const problems = checkPasswordPolicy(data.password, { minLength: DEFAULT_SECURITY.passwordMinLength }, { email: data.email });
      if (problems.length) throw new AppError("VALIDATION_FAILED", problems[0], { problems });
      if (await findUserByEmail(data.email)) throw new AppError("CONFLICT", "An account with that email already exists. Sign in instead.");
      const hash = await hashPassword(data.password);
      const [u] = await db.withSystem("auth.signup", (tx) => tx.insert(users).values({ email: data.email, name: data.name, passwordHash: hash, status: "active" }).returning());
      await orgs.create({ actor: SYSTEM_ACTOR("signup"), correlationId: meta.correlationId, ip: meta.ip, userAgent: meta.userAgent }, { name: data.organizationName, slug: data.organizationSlug, adminUserId: u!.id });
      return startSession(u!, "password", meta);
    },

    async bootstrapPlatformAdmin(input) {
      const existing = await db.withSystem("auth.bootstrap_check", (tx) => tx.select({ id: users.id }).from(users).where(eq(users.isPlatformAdmin, true)).limit(1));
      if (existing[0]) throw new AppError("CONFLICT", "A platform administrator already exists.");
      const problems = checkPasswordPolicy(input.password, { minLength: 12 }, { email: input.email });
      if (problems.length) throw new AppError("VALIDATION_FAILED", problems[0], { problems });
      const hash = await hashPassword(input.password);
      const [u] = await db.withSystem("auth.bootstrap", (tx) =>
        tx.insert(users).values({ email: input.email.toLowerCase(), name: input.name, passwordHash: hash, status: "active", isPlatformAdmin: true }).returning(),
      );
      return u!.id;
    },

    async changePassword(userId, sessionId, current, next, meta) {
      const [u] = await db.withSystem("auth.change_password", (tx) => tx.select().from(users).where(eq(users.id, userId)).limit(1));
      if (!u?.passwordHash || !(await verifyPassword(current, u.passwordHash))) throw new AppError("UNAUTHENTICATED", "Current password is incorrect.");
      const orgId = await defaultOrg(userId);
      const min = orgId ? (await orgs.settingsInternal(orgId)).security.passwordMinLength : DEFAULT_SECURITY.passwordMinLength;
      const problems = checkPasswordPolicy(next, { minLength: min }, { email: u.email });
      if (problems.length) throw new AppError("VALIDATION_FAILED", problems[0], { problems });
      const hash = await hashPassword(next);
      await db.withSystem("auth.change_password", (tx) => tx.update(users).set({ passwordHash: hash, updatedAt: new Date() }).where(eq(users.id, userId)));
      await sessions.revokeAllForUser(userId, "password_changed", sessionId);
      await auditFor(userId, orgId, userActor(u), meta, { action: AuditActions.PASSWORD_CHANGED });
    },

    async requestPasswordReset(email, meta) {
      const u = await findUserByEmail(email);
      // Always succeed from the caller's perspective: no account enumeration.
      if (!u || u.status !== "active" || !u.passwordHash) return;
      const token = randomToken(32);
      await db.withSystem("auth.reset_token", (tx) =>
        tx.insert(authTokens).values({ userId: u.id, purpose: "password_reset", tokenHash: sha256(token), expiresAt: new Date(Date.now() + 30 * 60_000) }),
      );
      await auditFor(u.id, await defaultOrg(u.id), userActor(u), meta, { action: AuditActions.PASSWORD_RESET_REQUESTED });
      if (deps.email.configured) {
        await deps.email.send({ to: u.email, subject: "Reset your password", text: `Use this link within 30 minutes:\n\n${deps.config.appUrl}/reset-password?token=${token}\n\nIf you did not request this, ignore this email.` });
      } else {
        deps.logger.warn("auth.password_reset_email_not_configured", { userId: u.id });
      }
    },

    async resetPassword(token, password, meta) {
      const [row] = await db.withSystem("auth.reset", (tx) =>
        tx
          .select({ t: authTokens, u: users })
          .from(authTokens)
          .innerJoin(users, eq(users.id, authTokens.userId))
          .where(and(eq(authTokens.tokenHash, sha256(token)), eq(authTokens.purpose, "password_reset"), isNull(authTokens.usedAt), gt(authTokens.expiresAt, new Date())))
          .limit(1),
      );
      if (!row) throw new AppError("NOT_FOUND", "This reset link is invalid or has expired.");
      const orgId = await defaultOrg(row.u.id);
      const min = orgId ? (await orgs.settingsInternal(orgId)).security.passwordMinLength : DEFAULT_SECURITY.passwordMinLength;
      const problems = checkPasswordPolicy(password, { minLength: min }, { email: row.u.email });
      if (problems.length) throw new AppError("VALIDATION_FAILED", problems[0], { problems });
      const hash = await hashPassword(password);
      await db.withSystem("auth.reset", async (tx) => {
        await tx.update(authTokens).set({ usedAt: new Date() }).where(eq(authTokens.id, row.t.id));
        await tx.update(users).set({ passwordHash: hash, failedLoginCount: 0, lockedUntil: null, updatedAt: new Date() }).where(eq(users.id, row.u.id));
      });
      await sessions.revokeAllForUser(row.u.id, "password_reset");
      await auditFor(row.u.id, orgId, userActor(row.u), meta, { action: AuditActions.PASSWORD_CHANGED, metadata: { via: "reset" } });
    },

    async beginMfaEnrollment(userId) {
      const [u] = await db.withSystem("auth.mfa_begin", (tx) => tx.select().from(users).where(eq(users.id, userId)).limit(1));
      if (!u) throw new AppError("NOT_FOUND");
      if (u.mfaEnabled) throw new AppError("CONFLICT", "MFA is already enabled.");
      const secret = generateTotpSecret();
      if (u.mfaSecretRef) await secrets.destroy(u.mfaSecretRef, null).catch(() => undefined);
      const ref = await secrets.put({ organizationId: null, name: `mfa:${userId}`, value: secret });
      await db.withSystem("auth.mfa_begin", (tx) => tx.update(users).set({ mfaSecretRef: ref }).where(eq(users.id, userId)));
      return { secret, otpauthUri: totpUri({ secret, account: u.email, issuer: deps.config.issuerName }) };
    },

    async confirmMfaEnrollment(userId, code, meta) {
      const [u] = await db.withSystem("auth.mfa_confirm", (tx) => tx.select().from(users).where(eq(users.id, userId)).limit(1));
      if (!u?.mfaSecretRef) throw new AppError("CONFLICT", "Start MFA enrollment first.");
      if (!verifyTotp(await secrets.get(u.mfaSecretRef, null), code)) throw new AppError("VALIDATION_FAILED", "Invalid verification code.");
      await db.withSystem("auth.mfa_confirm", (tx) => tx.update(users).set({ mfaEnabled: true }).where(eq(users.id, userId)));
      await auditFor(userId, await defaultOrg(userId), userActor(u), meta, { action: AuditActions.MFA_ENROLLED });
    },

    async disableMfa(userId, code, meta) {
      const [u] = await db.withSystem("auth.mfa_disable", (tx) => tx.select().from(users).where(eq(users.id, userId)).limit(1));
      if (!u?.mfaEnabled || !u.mfaSecretRef) throw new AppError("CONFLICT", "MFA is not enabled.");
      if (!verifyTotp(await secrets.get(u.mfaSecretRef, null), code)) throw new AppError("VALIDATION_FAILED", "Invalid verification code.");
      for (const o of await orgs.listForUser(userId)) {
        if ((await orgs.settingsInternal(o.id)).security.mfaRequired) throw new AppError("FORBIDDEN", `${o.name} requires MFA.`);
      }
      await secrets.destroy(u.mfaSecretRef, null);
      await db.withSystem("auth.mfa_disable", (tx) => tx.update(users).set({ mfaEnabled: false, mfaSecretRef: null }).where(eq(users.id, userId)));
      const orgId = await defaultOrg(userId);
      await auditFor(userId, orgId, userActor(u), meta, { action: AuditActions.MFA_DISABLED });
      if (orgId) {
        await deps.notifications.notify(tctx(orgId, SYSTEM_ACTOR("auth"), meta), { type: "core.security_alert", title: "Multi-factor authentication was disabled", body: `${u.email} disabled MFA on their account.`, recipients: { userIds: [userId] } });
      }
    },

    listSessions: (userId) => sessions.listForUser(userId),

    async revokeSession(userId, sessionId, meta) {
      const list = await sessions.listForUser(userId);
      if (!list.some((s) => s.id === sessionId)) throw new AppError("NOT_FOUND", "Session not found.");
      await sessions.revoke(sessionId, "user_revoked");
      const [u] = await db.withSystem("auth.revoke_session", (tx) => tx.select().from(users).where(eq(users.id, userId)).limit(1));
      await auditFor(userId, await defaultOrg(userId), userActor(u!), meta, { action: AuditActions.SESSION_REVOKED, metadata: { sessionId } });
    },

    async createSessionForUser(userId, organizationId, method, meta) {
      const [u] = await db.withSystem("auth.sso_session", (tx) => tx.select().from(users).where(eq(users.id, userId)).limit(1));
      if (!u || u.status !== "active") throw new AppError("UNAUTHENTICATED");
      const r = await startSession(u, method, meta, organizationId);
      return { token: r.token, session: r.session };
    },
  };
}
