import { and, backgroundJobsMetadata, count, desc, eq, inArray, sql, type Database } from "@eaop/db";
import { redactString, type Logger, type Metrics } from "@eaop/observability";
import { AppError, type Uuid } from "@eaop/shared-types";

/**
 * Reliable background job queue on PostgreSQL (FOR UPDATE SKIP LOCKED).
 * - At-least-once execution: handlers MUST be idempotent.
 * - Exponential backoff with jitter; jobs exceeding maxAttempts become "dead"
 *   (the dead-letter state) and surface on the admin health page.
 * - Enqueue inside a tenant transaction is transactional with that work.
 * Swap for SQS/Cloud Tasks/BullMQ by re-implementing `JobQueue`.
 */
export interface Job<P = Record<string, unknown>> {
  id: Uuid;
  organizationId: Uuid | null;
  type: string;
  payload: P;
  attempt: number;
  correlationId: string | null;
}

export interface JobHandler<P = Record<string, unknown>> {
  type: string;
  maxAttempts?: number;
  timeoutMs?: number;
  handle(job: Job<P>): Promise<void>;
}

export interface EnqueueOptions {
  organizationId?: Uuid | null;
  queue?: string;
  runAt?: Date;
  idempotencyKey?: string;
  maxAttempts?: number;
  correlationId?: string;
}

export interface QueueStats {
  byStatus: Record<string, number>;
  oldestQueuedSeconds: number | null;
}

export interface JobQueue {
  register(handler: JobHandler<never>): void;
  enqueue(type: string, payload: Record<string, unknown>, opts?: EnqueueOptions): Promise<Uuid | null>;
  /** Claim and run up to `batch` due jobs. Returns number processed. */
  runOnce(workerId: string, opts?: { queue?: string; batch?: number }): Promise<number>;
  stats(): Promise<QueueStats>;
  recentFailures(limit?: number, organizationId?: Uuid): Promise<Array<{ id: string; type: string; status: string; attempts: number; lastError: string | null; createdAt: string; organizationId: string | null }>>;
  retryDead(jobId: Uuid): Promise<void>;
  registeredTypes(): string[];
}

const STALE_LOCK_MINUTES = 15;

export function backoffSeconds(attempt: number): number {
  const base = Math.min(3600, 5 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

export function createJobQueue(deps: { db: Database; logger: Logger; metrics: Metrics }): JobQueue {
  const { db, logger, metrics } = deps;
  const handlers = new Map<string, JobHandler<never>>();

  async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new AppError("UPSTREAM_TIMEOUT", `Job timed out after ${ms}ms`, undefined, { retryable: true })), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    register(handler) {
      if (handlers.has(handler.type)) throw new Error(`Job handler already registered: ${handler.type}`);
      handlers.set(handler.type, handler);
    },
    registeredTypes: () => [...handlers.keys()].sort(),

    async enqueue(type, payload, opts = {}) {
      const scope = db.currentScope();
      const values = {
        organizationId: opts.organizationId ?? (scope?.kind === "tenant" ? scope.organizationId : null),
        queue: opts.queue ?? "default",
        type,
        payload,
        runAt: opts.runAt ?? new Date(),
        idempotencyKey: opts.idempotencyKey ?? null,
        maxAttempts: opts.maxAttempts ?? handlers.get(type)?.maxAttempts ?? 5,
        correlationId: opts.correlationId ?? null,
      };
      const exec = async (tx: Parameters<Parameters<Database["withSystem"]>[1]>[0]) => {
        const rows = await tx
          .insert(backgroundJobsMetadata)
          .values(values)
          .onConflictDoNothing({ target: [backgroundJobsMetadata.type, backgroundJobsMetadata.idempotencyKey] })
          .returning({ id: backgroundJobsMetadata.id });
        return rows[0]?.id ?? null;
      };
      // Join the caller's transaction when it is for the same tenant; otherwise system scope.
      if (scope?.kind === "tenant" && values.organizationId === scope.organizationId) return db.withTenant(scope, exec);
      return db.withSystem("jobs.enqueue", exec);
    },

    async runOnce(workerId, opts = {}) {
      const queue = opts.queue ?? "default";
      const batch = opts.batch ?? 10;
      const claimed = await db.withSystem("jobs.claim", async (tx) => {
        // Recover jobs whose worker died mid-run.
        await tx.execute(sql`update background_jobs_metadata set status = 'failed', locked_at = null, locked_by = null,
          last_error = 'worker lock expired' where status = 'running' and locked_at < now() - make_interval(mins => ${STALE_LOCK_MINUTES})`);
        const res = await tx.execute(sql`
          update background_jobs_metadata set status = 'running', locked_at = now(), locked_by = ${workerId}, attempts = attempts + 1
          where id in (
            select id from background_jobs_metadata
            where queue = ${queue} and status in ('queued', 'failed') and run_at <= now()
            order by run_at limit ${batch} for update skip locked
          ) returning id, organization_id, type, payload, attempts, max_attempts, correlation_id`);
        return res.rows as Array<{ id: string; organization_id: string | null; type: string; payload: Record<string, unknown>; attempts: number; max_attempts: number; correlation_id: string | null }>;
      });

      for (const row of claimed) {
        const handler = handlers.get(row.type);
        const started = performance.now();
        try {
          if (!handler) throw new AppError("NOT_IMPLEMENTED", `No handler registered for job type ${row.type}`);
          await withTimeout(
            handler.handle({ id: row.id, organizationId: row.organization_id, type: row.type, payload: row.payload as never, attempt: row.attempts, correlationId: row.correlation_id }),
            handler.timeoutMs ?? 60_000,
          );
          const ms = Math.round(performance.now() - started);
          await db.withSystem("jobs.complete", (tx) =>
            tx.update(backgroundJobsMetadata).set({ status: "succeeded", completedAt: new Date(), lockedAt: null, lockedBy: null, durationMs: ms, lastError: null }).where(eq(backgroundJobsMetadata.id, row.id)),
          );
          metrics.increment("eaop_jobs_total", { type: row.type, outcome: "succeeded" });
          metrics.observe("eaop_job_duration_ms", ms, { type: row.type });
        } catch (err) {
          const dead = row.attempts >= row.max_attempts || (err instanceof AppError && !err.retryable && err.code !== "UPSTREAM_TIMEOUT" && err.code !== "UPSTREAM_ERROR");
          const message = redactString(err instanceof Error ? err.message : String(err)).slice(0, 2000);
          await db.withSystem("jobs.fail", (tx) =>
            tx
              .update(backgroundJobsMetadata)
              .set({
                status: dead ? "dead" : "failed",
                lastError: message,
                lockedAt: null,
                lockedBy: null,
                runAt: new Date(Date.now() + backoffSeconds(row.attempts) * 1000),
                durationMs: Math.round(performance.now() - started),
              })
              .where(eq(backgroundJobsMetadata.id, row.id)),
          );
          metrics.increment("eaop_jobs_total", { type: row.type, outcome: dead ? "dead" : "failed" });
          logger.warn("job.failed", { jobId: row.id, type: row.type, attempt: row.attempts, dead, error: message });
        }
      }
      return claimed.length;
    },

    async stats() {
      return db.withSystem("jobs.stats", async (tx) => {
        const rows = await tx.select({ status: backgroundJobsMetadata.status, n: count() }).from(backgroundJobsMetadata).groupBy(backgroundJobsMetadata.status);
        const oldest = await tx.execute(sql`select extract(epoch from now() - min(run_at))::int as s from background_jobs_metadata where status = 'queued' and run_at <= now()`);
        return {
          byStatus: Object.fromEntries(rows.map((r) => [r.status, Number(r.n)])),
          oldestQueuedSeconds: (oldest.rows[0] as { s: number | null } | undefined)?.s ?? null,
        };
      });
    },

    async recentFailures(limit = 20, organizationId) {
      const run = (tx: Parameters<Parameters<Database["withSystem"]>[1]>[0]) =>
        tx
          .select()
          .from(backgroundJobsMetadata)
          .where(
            organizationId
              ? and(inArray(backgroundJobsMetadata.status, ["failed", "dead"]), eq(backgroundJobsMetadata.organizationId, organizationId))
              : inArray(backgroundJobsMetadata.status, ["failed", "dead"]),
          )
          .orderBy(desc(backgroundJobsMetadata.createdAt))
          .limit(limit);
      const rows = organizationId ? await db.withTenant({ organizationId }, run) : await db.withSystem("jobs.failures", run);
      return rows.map((r) => ({ id: r.id, type: r.type, status: r.status, attempts: r.attempts, lastError: r.lastError, createdAt: r.createdAt.toISOString(), organizationId: r.organizationId }));
    },

    async retryDead(jobId) {
      await db.withSystem("jobs.retry", (tx) =>
        tx.update(backgroundJobsMetadata).set({ status: "queued", attempts: 0, runAt: new Date(), lastError: null }).where(and(eq(backgroundJobsMetadata.id, jobId), eq(backgroundJobsMetadata.status, "dead"))),
      );
    },
  };
}
