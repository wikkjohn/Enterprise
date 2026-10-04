import { aiRuns, and, eq, idempotencyKeys, lt, notifications, organizations, organizationSettings, platformErrors, sql, usageEvents, eventOutbox, backgroundJobsMetadata, inArray } from "@eaop/db";
import { type Platform } from "./platform";

/**
 * Data-retention enforcement. Runs from the worker once a day. Every tenant's
 * own retention settings apply; the audit log is purged only through the
 * SECURITY DEFINER function (90-day floor enforced in the database).
 */
export async function runRetention(p: Platform): Promise<Record<string, number>> {
  const counts: Record<string, number> = { aiRuns: 0, notifications: 0, usageEvents: 0, auditEvents: 0 };
  const orgs = await p.db.withSystem("retention.orgs", (tx) =>
    tx.select({ id: organizations.id, retention: organizationSettings.dataRetention }).from(organizations).innerJoin(organizationSettings, eq(organizationSettings.organizationId, organizations.id)),
  );
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
  for (const o of orgs) {
    const r = o.retention;
    await p.db.withTenant({ organizationId: o.id }, async (tx) => {
      counts.aiRuns! += (await tx.delete(aiRuns).where(and(eq(aiRuns.organizationId, o.id), lt(aiRuns.createdAt, daysAgo(r.aiRunDays)))).returning({ id: aiRuns.id })).length;
      counts.notifications! += (await tx.delete(notifications).where(and(eq(notifications.organizationId, o.id), lt(notifications.createdAt, daysAgo(r.notificationDays)))).returning({ id: notifications.id })).length;
      counts.usageEvents! += (await tx.delete(usageEvents).where(and(eq(usageEvents.organizationId, o.id), lt(usageEvents.occurredAt, daysAgo(r.usageDays)))).returning({ id: usageEvents.id })).length;
      await tx.delete(idempotencyKeys).where(and(eq(idempotencyKeys.organizationId, o.id), lt(idempotencyKeys.expiresAt, new Date())));
    });
    const res = await p.db.withSystem("retention.audit", (tx) => tx.execute(sql`select eaop_purge_audit_events(${o.id}::uuid, ${daysAgo(Math.max(90, r.auditDays)).toISOString()}::timestamptz) as n`));
    counts.auditEvents! += Number((res.rows[0] as { n: number | string }).n);
  }
  await p.db.withSystem("retention.platform", async (tx) => {
    await tx.delete(platformErrors).where(lt(platformErrors.occurredAt, daysAgo(30)));
    await tx.delete(eventOutbox).where(and(eq(eventOutbox.status, "dispatched"), lt(eventOutbox.occurredAt, daysAgo(14))));
    await tx.delete(backgroundJobsMetadata).where(and(inArray(backgroundJobsMetadata.status, ["succeeded", "cancelled"]), lt(backgroundJobsMetadata.createdAt, daysAgo(14))));
  });
  return counts;
}
