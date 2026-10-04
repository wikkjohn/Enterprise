import { z } from "zod";
import {
  and, desc, eq, inArray, isNull, lt, memberRoles, memberships, notificationPreferences, notifications, or, rolePermissions, roles, scopeOf, sql, users,
  type Database,
} from "@eaop/db";
import { type JobQueue } from "@eaop/jobs";
import { type Logger } from "@eaop/observability";
import { assertSafeOutboundUrl } from "@eaop/security";
import { AppError, decodeCursor, encodeCursor, type OwnerId, type Page, type Priority, type TenantContext } from "@eaop/shared-types";

export type NotificationChannel = "in_app" | "email" | "webhook";

export interface NotificationTypeDefinition {
  key: string;
  owner: OwnerId;
  description: string;
  defaultPriority: Priority;
  channels: NotificationChannel[];
  /** Mandatory types (e.g. security alerts) ignore user opt-outs for in-app delivery. */
  mandatory?: boolean;
}

export class NotificationTypeRegistry {
  private types = new Map<string, NotificationTypeDefinition>();
  register(def: NotificationTypeDefinition) {
    const existing = this.types.get(def.key);
    if (existing && existing.owner !== def.owner) throw new Error(`Notification type "${def.key}" already owned by "${existing.owner}"`);
    this.types.set(def.key, def);
  }
  get(key: string) {
    return this.types.get(key);
  }
  list() {
    return [...this.types.values()].sort((a, b) => a.key.localeCompare(b.key));
  }
}

export const CORE_NOTIFICATION_TYPES: NotificationTypeDefinition[] = [
  { key: "core.invitation_accepted", owner: "core", description: "Someone accepted an invitation.", defaultPriority: "low", channels: ["in_app"] },
  { key: "core.connector_failed", owner: "core", description: "A connector failed a health check or action.", defaultPriority: "high", channels: ["in_app", "email"] },
  { key: "core.credential_expiring", owner: "core", description: "A connector credential will expire soon.", defaultPriority: "high", channels: ["in_app", "email"] },
  { key: "core.security_alert", owner: "core", description: "Security-relevant change (MFA disabled, new admin, etc.).", defaultPriority: "critical", channels: ["in_app", "email"], mandatory: true },
  { key: "core.usage_threshold", owner: "core", description: "Usage crossed a configured limit.", defaultPriority: "high", channels: ["in_app", "email"] },
  { key: "core.module_changed", owner: "core", description: "A module was enabled or disabled.", defaultPriority: "normal", channels: ["in_app"] },
];

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Pluggable email transport. No transport is assumed; see docs/DEPLOYMENT.md. */
export interface EmailSender {
  readonly configured: boolean;
  send(msg: EmailMessage): Promise<void>;
}

export class UnconfiguredEmailSender implements EmailSender {
  readonly configured = false;
  constructor(private readonly logger: Logger) {}
  async send(msg: EmailMessage) {
    this.logger.info("email.not_configured", { subject: msg.subject });
  }
}

/** Posts messages as JSON to a relay you operate (e.g. a function that calls SES/SendGrid). */
export class WebhookEmailSender implements EmailSender {
  readonly configured = true;
  constructor(private readonly url: string, private readonly fetchImpl: typeof fetch = fetch) {}
  async send(msg: EmailMessage) {
    await assertSafeOutboundUrl(this.url, { allowHttp: process.env.APP_ENV !== "production", allowPrivateNetworks: process.env.APP_ENV !== "production" });
    const res = await this.fetchImpl(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new AppError("UPSTREAM_ERROR", `Email relay responded ${res.status}`, undefined, { retryable: true });
  }
}

export const notifyInputSchema = z.object({
  type: z.string().min(3).max(120),
  title: z.string().min(1).max(200),
  body: z.string().max(4000).default(""),
  /** Must be an in-app relative path to prevent open redirects. */
  actionUrl: z.string().regex(/^\/(?!\/)[^\s]*$/, "actionUrl must be a relative path").max(500).optional(),
  priority: z.enum(["low", "normal", "high", "critical"]).optional(),
  resource: z.object({ type: z.string().max(64), id: z.string().max(128) }).optional(),
  recipients: z.object({
    userIds: z.array(z.string().uuid()).max(1000).optional(),
    roleKeys: z.array(z.string()).max(20).optional(),
    permission: z.string().max(120).optional(),
    allMembers: z.boolean().optional(),
  }),
  metadata: z.record(z.unknown()).optional(),
});
export type NotifyInput = z.input<typeof notifyInputSchema>;

export interface NotificationView {
  id: string;
  type: string;
  moduleId: string;
  priority: string;
  title: string;
  body: string;
  actionUrl: string | null;
  resourceType: string | null;
  resourceId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationService {
  notify(ctx: TenantContext, input: NotifyInput): Promise<{ recipients: number }>;
  listMine(ctx: TenantContext, q: { unreadOnly?: boolean; limit?: number; cursor?: string }): Promise<Page<NotificationView>>;
  unreadCount(ctx: TenantContext): Promise<number>;
  markRead(ctx: TenantContext, ids: string[] | "all"): Promise<void>;
  preferences(ctx: TenantContext): Promise<Array<{ type: string; description: string; channel: NotificationChannel; enabled: boolean; mandatory: boolean }>>;
  setPreference(ctx: TenantContext, type: string, channel: NotificationChannel, enabled: boolean): Promise<void>;
}

export function createNotificationService(deps: { db: Database; registry: NotificationTypeRegistry; jobs: JobQueue; email: EmailSender; logger: Logger }): NotificationService {
  const { db, registry, jobs, email } = deps;

  jobs.register({
    type: "notifications.email",
    maxAttempts: 5,
    async handle(job) {
      const { notificationId } = job.payload as { notificationId: string };
      const [row] = await db.withTenant({ organizationId: job.organizationId! }, (tx) =>
        tx
          .select({ title: notifications.title, body: notifications.body, actionUrl: notifications.actionUrl, email: users.email })
          .from(notifications)
          .innerJoin(users, eq(users.id, notifications.recipientUserId))
          .where(eq(notifications.id, notificationId))
          .limit(1),
      );
      if (!row) return;
      const link = row.actionUrl ? `\n\n${(process.env.APP_URL ?? "").replace(/\/$/, "")}${row.actionUrl}` : "";
      await email.send({ to: row.email, subject: row.title, text: `${row.body}${link}` });
    },
  });

  const view = (r: typeof notifications.$inferSelect): NotificationView => ({
    id: r.id,
    type: r.type,
    moduleId: r.moduleId,
    priority: r.priority,
    title: r.title,
    body: r.body,
    actionUrl: r.actionUrl,
    resourceType: r.resourceType,
    resourceId: r.resourceId,
    readAt: r.readAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  });

  return {
    async notify(ctx, raw) {
      const input = notifyInputSchema.parse(raw);
      const def = registry.get(input.type);
      if (!def) throw new AppError("INTERNAL", `Unregistered notification type "${input.type}".`);

      return db.withTenant(scopeOf(ctx), async (tx) => {
        const recipientIds = new Set<string>();
        const active = and(eq(memberships.organizationId, ctx.organizationId), eq(memberships.status, "active"));
        if (input.recipients.userIds?.length) {
          const rows = await tx.select({ userId: memberships.userId }).from(memberships).where(and(active, inArray(memberships.userId, input.recipients.userIds)));
          rows.forEach((r) => recipientIds.add(r.userId));
        }
        if (input.recipients.allMembers) {
          (await tx.select({ userId: memberships.userId }).from(memberships).where(active)).forEach((r) => recipientIds.add(r.userId));
        }
        if (input.recipients.roleKeys?.length || input.recipients.permission) {
          const conds = [];
          if (input.recipients.roleKeys?.length) conds.push(inArray(roles.key, input.recipients.roleKeys));
          if (input.recipients.permission) conds.push(eq(rolePermissions.permissionKey, input.recipients.permission));
          const rows = await tx
            .selectDistinct({ userId: memberships.userId })
            .from(memberships)
            .innerJoin(memberRoles, and(eq(memberRoles.membershipId, memberships.id), isNull(memberRoles.scopeType)))
            .innerJoin(roles, eq(roles.id, memberRoles.roleId))
            .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
            .where(and(active, or(...conds)));
          rows.forEach((r) => recipientIds.add(r.userId));
        }
        if (recipientIds.size === 0) return { recipients: 0 };

        const prefs = await tx
          .select()
          .from(notificationPreferences)
          .where(and(eq(notificationPreferences.organizationId, ctx.organizationId), eq(notificationPreferences.type, def.key), inArray(notificationPreferences.userId, [...recipientIds])));
        const optedOut = (userId: string, channel: NotificationChannel) =>
          !def.mandatory && prefs.some((p) => p.userId === userId && p.channel === channel && p.enabled === "off");

        let delivered = 0;
        for (const userId of recipientIds) {
          if (optedOut(userId, "in_app") && optedOut(userId, "email")) continue;
          const [row] = await tx
            .insert(notifications)
            .values({
              organizationId: ctx.organizationId,
              recipientUserId: userId,
              type: def.key,
              moduleId: def.owner,
              priority: input.priority ?? def.defaultPriority,
              title: input.title,
              body: input.body,
              actionUrl: input.actionUrl ?? null,
              resourceType: input.resource?.type ?? null,
              resourceId: input.resource?.id ?? null,
              metadata: input.metadata ?? {},
              // Users who opted out of in-app but not email still get an archived record for audit.
              readAt: optedOut(userId, "in_app") ? new Date() : null,
            })
            .returning({ id: notifications.id });
          delivered++;
          if (def.channels.includes("email") && !optedOut(userId, "email") && email.configured) {
            await jobs.enqueue("notifications.email", { notificationId: row!.id }, { organizationId: ctx.organizationId, idempotencyKey: `email:${row!.id}` });
          }
        }
        return { recipients: delivered };
      });
    },

    async listMine(ctx, q) {
      if (ctx.actor.type !== "user") return { data: [] };
      const limit = Math.min(q.limit ?? 20, 100);
      const cursor = decodeCursor(q.cursor);
      const conds = [eq(notifications.organizationId, ctx.organizationId), eq(notifications.recipientUserId, ctx.actor.id)];
      if (q.unreadOnly) conds.push(isNull(notifications.readAt));
      if (cursor) {
        const t = new Date(cursor.t);
        conds.push(or(lt(notifications.createdAt, t), and(eq(notifications.createdAt, t), lt(notifications.id, cursor.id)))!);
      }
      const rows = await db.withTenant(scopeOf(ctx), (tx) =>
        tx.select().from(notifications).where(and(...conds)).orderBy(desc(notifications.createdAt), desc(notifications.id)).limit(limit + 1),
      );
      const last = rows.length > limit ? rows[limit - 1] : undefined;
      return { data: rows.slice(0, limit).map(view), nextCursor: last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : undefined };
    },

    async unreadCount(ctx) {
      if (ctx.actor.type !== "user") return 0;
      const [r] = await db.withTenant(scopeOf(ctx), (tx) =>
        tx
          .select({ n: sql<number>`count(*)::int` })
          .from(notifications)
          .where(and(eq(notifications.organizationId, ctx.organizationId), eq(notifications.recipientUserId, ctx.actor.id), isNull(notifications.readAt))),
      );
      return r?.n ?? 0;
    },

    async markRead(ctx, ids) {
      if (ctx.actor.type !== "user") return;
      const base = and(eq(notifications.organizationId, ctx.organizationId), eq(notifications.recipientUserId, ctx.actor.id), isNull(notifications.readAt));
      await db.withTenant(scopeOf(ctx), (tx) =>
        tx
          .update(notifications)
          .set({ readAt: new Date() })
          .where(ids === "all" ? base : and(base, inArray(notifications.id, ids.slice(0, 500)))),
      );
    },

    async preferences(ctx) {
      if (ctx.actor.type !== "user") return [];
      const rows = await db.withTenant(scopeOf(ctx), (tx) =>
        tx.select().from(notificationPreferences).where(and(eq(notificationPreferences.organizationId, ctx.organizationId), eq(notificationPreferences.userId, ctx.actor.id))),
      );
      return registry.list().flatMap((def) =>
        def.channels.map((channel) => ({
          type: def.key,
          description: def.description,
          channel,
          mandatory: !!def.mandatory,
          enabled: !rows.some((r) => r.type === def.key && r.channel === channel && r.enabled === "off"),
        })),
      );
    },

    async setPreference(ctx, type, channel, enabled) {
      if (ctx.actor.type !== "user") throw new AppError("FORBIDDEN", "Only users have notification preferences.");
      const def = registry.get(type);
      if (!def || !def.channels.includes(channel)) throw new AppError("VALIDATION_FAILED", "Unknown notification type or channel.");
      if (def.mandatory && !enabled) throw new AppError("VALIDATION_FAILED", "This notification type is mandatory.");
      await db.withTenant(scopeOf(ctx), (tx) =>
        tx
          .insert(notificationPreferences)
          .values({ organizationId: ctx.organizationId, userId: ctx.actor.id, type, channel, enabled: enabled ? "on" : "off" })
          .onConflictDoUpdate({
            target: [notificationPreferences.organizationId, notificationPreferences.userId, notificationPreferences.type, notificationPreferences.channel],
            set: { enabled: enabled ? "on" : "off", updatedAt: new Date() },
          }),
      );
    },
  };
}
