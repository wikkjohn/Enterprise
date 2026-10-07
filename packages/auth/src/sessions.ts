import { and, eq, gt, isNull, ne, sessions, sql, users, type Database } from "@eaop/db";
import { randomToken, sha256 } from "@eaop/security";
import { type Uuid } from "@eaop/shared-types";

export interface SessionRecord {
  id: Uuid;
  userId: Uuid;
  activeOrganizationId: Uuid | null;
  authMethod: "password" | "oidc" | "saml";
  mfaPending: boolean;
  mfaFailedCount: number;
  mfaVerifiedAt: Date | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
}

export interface SessionUser {
  id: Uuid;
  email: string;
  name: string;
  status: string;
  isPlatformAdmin: boolean;
  mfaEnabled: boolean;
}

/** Hard cap regardless of org policy. */
export const ABSOLUTE_SESSION_HOURS = 24 * 7;
const TOUCH_INTERVAL_MS = 60_000;

/**
 * Opaque, server-side sessions. The cookie holds a 256-bit random token; the
 * DB stores only its SHA-256. Idle and absolute timeouts are enforced on every
 * validation; organization policy can only shorten them.
 */
export class SessionManager {
  constructor(private readonly db: Database) {}

  async create(input: { userId: Uuid; activeOrganizationId: Uuid | null; authMethod: SessionRecord["authMethod"]; mfaPending: boolean; ip?: string; userAgent?: string; maxHours: number }) {
    const token = randomToken(32);
    const hours = Math.min(input.maxHours, ABSOLUTE_SESSION_HOURS);
    const [row] = await this.db.withSystem("sessions.create", (tx) =>
      tx
        .insert(sessions)
        .values({
          userId: input.userId,
          tokenHash: sha256(token),
          activeOrganizationId: input.activeOrganizationId,
          authMethod: input.authMethod,
          mfaPending: input.mfaPending,
          ip: input.ip ?? null,
          userAgent: input.userAgent?.slice(0, 512) ?? null,
          expiresAt: new Date(Date.now() + hours * 3600_000),
        })
        .returning(),
    );
    return { token, session: row! as SessionRecord };
  }

  /** Returns the live session + user, or null. `idleMinutes` comes from the active org's policy. */
  async validate(token: string, idleMinutesFor: (orgId: Uuid | null) => Promise<number>): Promise<{ session: SessionRecord; user: SessionUser } | null> {
    if (!token || token.length > 128) return null;
    const rows = await this.db.withSystem("sessions.validate", (tx) =>
      tx
        .select({ s: sessions, u: { id: users.id, email: users.email, name: users.name, status: users.status, isPlatformAdmin: users.isPlatformAdmin, mfaEnabled: users.mfaEnabled } })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(and(eq(sessions.tokenHash, sha256(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())))
        .limit(1),
    );
    const row = rows[0];
    if (!row) return null;
    if (row.u.status !== "active") {
      await this.revoke(row.s.id, "user_inactive");
      return null;
    }
    const idle = await idleMinutesFor(row.s.activeOrganizationId);
    if (Date.now() - row.s.lastSeenAt.getTime() > idle * 60_000) {
      await this.revoke(row.s.id, "idle_timeout");
      return null;
    }
    if (Date.now() - row.s.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.db.withSystem("sessions.touch", (tx) => tx.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, row.s.id)));
    }
    return { session: row.s as SessionRecord, user: row.u };
  }

  async setActiveOrganization(sessionId: Uuid, organizationId: Uuid | null) {
    await this.db.withSystem("sessions.switch_org", (tx) => tx.update(sessions).set({ activeOrganizationId: organizationId }).where(eq(sessions.id, sessionId)));
  }

  async completeMfa(sessionId: Uuid) {
    await this.db.withSystem("sessions.mfa", (tx) => tx.update(sessions).set({ mfaPending: false, mfaVerifiedAt: new Date(), mfaFailedCount: 0 }).where(eq(sessions.id, sessionId)));
  }

  /** Record a failed second-factor attempt on a session; returns the new failure count. */
  async recordMfaFailure(sessionId: Uuid): Promise<number> {
    const [row] = await this.db.withSystem("sessions.mfa_fail", (tx) =>
      tx.update(sessions).set({ mfaFailedCount: sql`${sessions.mfaFailedCount} + 1` }).where(eq(sessions.id, sessionId)).returning({ n: sessions.mfaFailedCount }),
    );
    return row?.n ?? 0;
  }

  async revoke(sessionId: Uuid, reason: string) {
    await this.db.withSystem("sessions.revoke", (tx) => tx.update(sessions).set({ revokedAt: new Date(), revokedReason: reason }).where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt))));
  }

  async revokeAllForUser(userId: Uuid, reason: string, exceptSessionId?: Uuid) {
    const conds = [eq(sessions.userId, userId), isNull(sessions.revokedAt)];
    if (exceptSessionId) conds.push(ne(sessions.id, exceptSessionId));
    await this.db.withSystem("sessions.revoke_all", (tx) => tx.update(sessions).set({ revokedAt: new Date(), revokedReason: reason }).where(and(...conds)));
  }

  async listForUser(userId: Uuid) {
    return this.db.withUser(userId, (tx) =>
      tx
        .select({ id: sessions.id, createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt, expiresAt: sessions.expiresAt, ip: sessions.ip, userAgent: sessions.userAgent, authMethod: sessions.authMethod })
        .from(sessions)
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())))
        .orderBy(sessions.lastSeenAt),
    );
  }
}
