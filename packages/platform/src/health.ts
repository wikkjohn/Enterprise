import { and, connectors, count, desc, eq, gte, or, platformErrors, sql, type Database } from "@eaop/db";
import { type AIService } from "@eaop/ai";
import { type JobQueue } from "@eaop/jobs";
import { type ModuleService } from "@eaop/module-registry";
import { type Authorizer } from "@eaop/rbac";
import { type HealthState, type TenantContext } from "@eaop/shared-types";

export interface HealthReport {
  generatedAt: string;
  overall: HealthState;
  services: Array<{ name: string; state: HealthState; message?: string; latencyMs?: number }>;
  queue: { byStatus: Record<string, number>; oldestQueuedSeconds: number | null } | null;
  failedJobs: Array<{ id: string; type: string; status: string; attempts: number; lastError: string | null; createdAt: string }>;
  connectors: { total: number; byHealth: Record<string, number>; failing: Array<{ id: string; name: string; type: string; lastError: string | null }> };
  aiProviders: Array<{ key: string; kind: string; status: string; implemented: boolean }>;
  modules: Array<{ moduleId: string; state: HealthState; message?: string }>;
  recentErrors: Array<{ id: string; occurredAt: string; severity: string; source: string; code: string | null; message: string; correlationId: string | null }>;
}

/**
 * Admin health page data. Tenant admins (observability.read) see their own
 * connectors/jobs/errors; queue internals and platform-wide errors are
 * shown only to platform administrators.
 */
export function createHealthService(deps: { db: Database; jobs: JobQueue; ai: AIService; modules: ModuleService; authorizer: Authorizer }) {
  const { db } = deps;

  async function dbCheck() {
    const started = performance.now();
    try {
      await db.pool.query("select 1");
      return { name: "database", state: "healthy" as HealthState, latencyMs: Math.round(performance.now() - started) };
    } catch (e) {
      return { name: "database", state: "unhealthy" as HealthState, message: (e as Error).message.slice(0, 200) };
    }
  }

  return {
    /** Unauthenticated liveness/readiness (no details). */
    async probe(): Promise<{ ok: boolean }> {
      return { ok: (await dbCheck()).state === "healthy" };
    },

    async report(ctx: TenantContext): Promise<HealthReport> {
      await deps.authorizer.require(ctx, "observability.read");
      const platformAdmin = ctx.actor.isPlatformAdmin === true;
      const database = await dbCheck();
      const stats = platformAdmin ? await deps.jobs.stats() : null;
      const failedJobs = await deps.jobs.recentFailures(15, platformAdmin ? undefined : ctx.organizationId);
      const conns = await db.withTenant({ organizationId: ctx.organizationId }, async (tx) => {
        const byHealth = await tx.select({ h: connectors.healthStatus, n: count() }).from(connectors).groupBy(connectors.healthStatus);
        const failing = await tx
          .select({ id: connectors.id, name: connectors.name, type: connectors.type, lastError: connectors.lastError })
          .from(connectors)
          .where(or(eq(connectors.healthStatus, "unhealthy"), eq(connectors.status, "failed")))
          .limit(20);
        return { byHealth: Object.fromEntries(byHealth.map((r) => [r.h, Number(r.n)])), failing };
      });
      const since = new Date(Date.now() - 7 * 86_400_000);
      const errors = await db.withSystem("health.errors", (tx) =>
        tx
          .select()
          .from(platformErrors)
          .where(
            and(
              gte(platformErrors.occurredAt, since),
              platformAdmin ? sql`true` : eq(platformErrors.organizationId, ctx.organizationId),
              or(eq(platformErrors.severity, "critical"), eq(platformErrors.severity, "error")),
            ),
          )
          .orderBy(desc(platformErrors.occurredAt))
          .limit(25),
      );
      const modules = (await deps.modules.health()).map((m) => ({ moduleId: m.moduleId, state: m.status.state, message: m.status.message }));
      const ai = await deps.ai.providerStatus();
      const queueState: HealthState = stats ? ((stats.byStatus.dead ?? 0) > 0 || (stats.oldestQueuedSeconds ?? 0) > 600 ? "degraded" : "healthy") : "unknown";
      const services = [database, { name: "job_queue", state: queueState }, { name: "event_bus", state: "healthy" as HealthState }];
      const overall: HealthState = services.some((s) => s.state === "unhealthy") ? "unhealthy" : services.some((s) => s.state === "degraded") || conns.failing.length ? "degraded" : "healthy";
      return {
        generatedAt: new Date().toISOString(),
        overall,
        services,
        queue: stats,
        failedJobs,
        connectors: { total: Object.values(conns.byHealth).reduce((a, b) => a + b, 0), ...conns },
        aiProviders: ai,
        modules,
        recentErrors: errors.map((e) => ({ id: e.id, occurredAt: e.occurredAt.toISOString(), severity: e.severity, source: e.source, code: e.code, message: e.message, correlationId: e.correlationId })),
      };
    },
  };
}

export type HealthService = ReturnType<typeof createHealthService>;
