import { z } from "zod";
import { and, auditEvents, desc, eq, gte, ilike, lt, lte, or, scopeOf, type Database, type Tx } from "@eaop/db";
import { redact, type Logger } from "@eaop/observability";
import { decodeCursor, encodeCursor, type OwnerId, type Page, type TenantContext } from "@eaop/shared-types";

/** Well-known audit actions. Modules add their own namespaced actions (e.g. "workflow.approved"). */
export const AuditActions = {
  LOGIN: "auth.login",
  LOGIN_FAILED: "auth.login_failed",
  LOGOUT: "auth.logout",
  MFA_ENROLLED: "auth.mfa_enrolled",
  MFA_DISABLED: "auth.mfa_disabled",
  PASSWORD_CHANGED: "auth.password_changed",
  PASSWORD_RESET_REQUESTED: "auth.password_reset_requested",
  SESSION_REVOKED: "auth.session_revoked",
  ORG_SWITCHED: "auth.organization_switched",
  ORG_CREATED: "organization.created",
  ORG_UPDATED: "organization.updated",
  ORG_STATUS_CHANGED: "organization.status_changed",
  SETTINGS_CHANGED: "organization.settings_changed",
  DOMAIN_ADDED: "organization.domain_added",
  DOMAIN_VERIFIED: "organization.domain_verified",
  USER_INVITED: "user.invited",
  INVITATION_ACCEPTED: "user.invitation_accepted",
  INVITATION_REVOKED: "user.invitation_revoked",
  MEMBER_SUSPENDED: "user.suspended",
  MEMBER_REACTIVATED: "user.reactivated",
  MEMBER_REMOVED: "user.removed",
  ROLE_CREATED: "rbac.role_created",
  ROLE_UPDATED: "rbac.role_updated",
  ROLE_DELETED: "rbac.role_deleted",
  ROLE_ASSIGNED: "rbac.role_assigned",
  ROLE_REVOKED: "rbac.role_revoked",
  PERMISSION_DENIED: "rbac.permission_denied",
  MODULE_ENABLED: "module.enabled",
  MODULE_DISABLED: "module.disabled",
  FEATURE_FLAG_CHANGED: "module.feature_flag_changed",
  CONNECTOR_CREATED: "connector.created",
  CONNECTOR_UPDATED: "connector.updated",
  CONNECTOR_DELETED: "connector.deleted",
  CONNECTOR_TESTED: "connector.tested",
  CREDENTIAL_SET: "connector.credential_set",
  CREDENTIAL_ROTATED: "connector.credential_rotated",
  CREDENTIAL_REVOKED: "connector.credential_revoked",
  AI_PROVIDER_CHANGED: "ai.provider_changed",
  AI_MODEL_CHANGED: "ai.model_changed",
  POLICY_CREATED: "policy.created",
  POLICY_VERSIONED: "policy.versioned",
  POLICY_ACTIVATED: "policy.activated",
  POLICY_DISABLED: "policy.disabled",
  API_KEY_CREATED: "api_key.created",
  API_KEY_REVOKED: "api_key.revoked",
  WEBHOOK_CREATED: "webhook.created",
  WEBHOOK_DELETED: "webhook.deleted",
  IDP_CHANGED: "sso.identity_provider_changed",
  DATA_EXPORTED: "data.exported",
  ADMIN_ACTION: "admin.action",
} as const;

export interface AuditRecordInput {
  module?: OwnerId;
  action: string;
  resourceType?: string;
  resourceId?: string;
  outcome?: "success" | "failure" | "denied";
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

export interface AuditEventView {
  id: string;
  organizationId: string | null;
  occurredAt: string;
  actorType: string;
  actorId: string;
  actorLabel: string;
  module: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  outcome: string;
  before: unknown;
  after: unknown;
  metadata: Record<string, unknown>;
  ip: string | null;
  userAgent: string | null;
  correlationId: string | null;
}

export const auditQuerySchema = z.object({
  action: z.string().max(128).optional(),
  module: z.string().max(64).optional(),
  actorId: z.string().max(128).optional(),
  resourceType: z.string().max(64).optional(),
  resourceId: z.string().max(128).optional(),
  outcome: z.enum(["success", "failure", "denied"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  q: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  cursor: z.string().max(512).optional(),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

type Row = typeof auditEvents.$inferSelect;
const toView = (r: Row): AuditEventView => ({ ...r, occurredAt: r.occurredAt.toISOString(), metadata: r.metadata ?? {} });

/** Strip noisy/secret fields from before/after snapshots. */
function snapshot(value: unknown) {
  return value === undefined ? null : (redact(value) as object | null);
}

export interface AuditService {
  /**
   * Record within the caller's current transaction when there is one (atomic
   * with the change being audited), otherwise in its own transaction.
   */
  record(ctx: TenantContext, input: AuditRecordInput): Promise<void>;
  /** Record in an independent transaction — survives a rollback of the caller (denials, failures). */
  recordDetached(ctx: TenantContext, input: AuditRecordInput): Promise<void>;
  /** Platform-level event without a tenant (e.g. login failure for an unknown email). */
  recordPlatform(meta: { actorType: string; actorId: string; actorLabel: string; ip?: string; userAgent?: string; correlationId: string }, input: AuditRecordInput): Promise<void>;
  /** Caller must have checked `audit.read`. */
  query(ctx: TenantContext, q: AuditQuery): Promise<Page<AuditEventView>>;
}

export function createAuditService(deps: { db: Database; logger: Logger }): AuditService {
  const { db, logger } = deps;

  const values = (ctx: TenantContext, input: AuditRecordInput) => ({
    organizationId: ctx.organizationId,
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    actorLabel: ctx.actor.label,
    module: input.module ?? "core",
    action: input.action,
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId ?? null,
    outcome: input.outcome ?? "success",
    before: snapshot(input.before),
    after: snapshot(input.after),
    metadata: (redact(input.metadata ?? {}) as Record<string, unknown>) ?? {},
    ip: ctx.ip ?? null,
    userAgent: ctx.userAgent?.slice(0, 512) ?? null,
    correlationId: ctx.correlationId,
  });

  const insert = (tx: Tx, ctx: TenantContext, input: AuditRecordInput) => tx.insert(auditEvents).values(values(ctx, input));

  return {
    async record(ctx, input) {
      await db.withTenant(scopeOf(ctx), (tx) => insert(tx, ctx, input));
    },
    async recordDetached(ctx, input) {
      // A fresh async context so we never join the caller's (possibly failing) transaction.
      await new Promise<void>((resolve) => {
        setImmediate(() => {
          db.withTenant(scopeOf(ctx), (tx) => insert(tx, ctx, input))
            .catch((err) => logger.error("audit.record_detached_failed", { err, action: input.action }))
            .finally(resolve);
        });
      });
    },
    async recordPlatform(meta, input) {
      await db.withSystem("audit.platform", (tx) =>
        tx.insert(auditEvents).values({
          organizationId: null,
          actorType: meta.actorType,
          actorId: meta.actorId,
          actorLabel: meta.actorLabel,
          module: input.module ?? "core",
          action: input.action,
          resourceType: input.resourceType ?? null,
          resourceId: input.resourceId ?? null,
          outcome: input.outcome ?? "success",
          before: snapshot(input.before),
          after: snapshot(input.after),
          metadata: (redact(input.metadata ?? {}) as Record<string, unknown>) ?? {},
          ip: meta.ip ?? null,
          userAgent: meta.userAgent?.slice(0, 512) ?? null,
          correlationId: meta.correlationId,
        }),
      );
    },
    async query(ctx, q) {
      const cursor = decodeCursor(q.cursor);
      const conds = [eq(auditEvents.organizationId, ctx.organizationId)];
      if (q.action) conds.push(eq(auditEvents.action, q.action));
      if (q.module) conds.push(eq(auditEvents.module, q.module));
      if (q.actorId) conds.push(eq(auditEvents.actorId, q.actorId));
      if (q.resourceType) conds.push(eq(auditEvents.resourceType, q.resourceType));
      if (q.resourceId) conds.push(eq(auditEvents.resourceId, q.resourceId));
      if (q.outcome) conds.push(eq(auditEvents.outcome, q.outcome));
      if (q.from) conds.push(gte(auditEvents.occurredAt, q.from));
      if (q.to) conds.push(lte(auditEvents.occurredAt, q.to));
      if (q.q) {
        const like = `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
        conds.push(or(ilike(auditEvents.action, like), ilike(auditEvents.actorLabel, like), ilike(auditEvents.resourceId, like))!);
      }
      if (cursor) {
        const t = new Date(cursor.t);
        conds.push(or(lt(auditEvents.occurredAt, t), and(eq(auditEvents.occurredAt, t), lt(auditEvents.id, cursor.id)))!);
      }
      const rows = await db.withTenant(scopeOf(ctx), (tx) =>
        tx.select().from(auditEvents).where(and(...conds)).orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id)).limit(q.limit + 1),
      );
      const page = rows.slice(0, q.limit).map(toView);
      const last = rows.length > q.limit ? rows[q.limit - 1] : undefined;
      return { data: page, nextCursor: last ? encodeCursor({ t: last.occurredAt.toISOString(), id: last.id }) : undefined };
    },
  };
}
