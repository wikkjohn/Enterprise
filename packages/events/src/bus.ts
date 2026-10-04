import { and, eq, eventOutbox, inArray, lte, scopeOf, sql, type Database } from "@eaop/db";
import { type JobQueue } from "@eaop/jobs";
import { redactString, type Logger, type Metrics } from "@eaop/observability";
import { AppError, type TenantContext } from "@eaop/shared-types";
import { type EventRegistry, type PlatformEvent } from "./contracts";

export type EventHandler = (event: PlatformEvent) => Promise<void>;

/**
 * Shared event bus with a transactional outbox:
 *   publish() validates against the registered contract and writes the event
 *   to event_outbox INSIDE the caller's transaction. After commit it is
 *   dispatched in-process; the worker re-dispatches anything left pending.
 * Delivery is at-least-once. A failing subscriber is retried individually
 * through the job queue, so other subscribers are not re-run.
 */
export interface EventBus {
  publish<P extends Record<string, unknown>>(ctx: TenantContext, type: string, payload: P): Promise<string>;
  publishPlatform<P extends Record<string, unknown>>(type: string, payload: P, meta?: { correlationId?: string }): Promise<string>;
  /** `name` must be unique and stable; it identifies the subscriber for retries. */
  subscribe(type: string | "*", name: string, handler: EventHandler): void;
  dispatchPending(limit?: number): Promise<number>;
}

export function createEventBus(deps: { db: Database; registry: EventRegistry; jobs: JobQueue; logger: Logger; metrics: Metrics }): EventBus {
  const { db, registry, jobs, logger, metrics } = deps;
  const subscribers = new Map<string, { type: string; handler: EventHandler }>();

  function validate(type: string, payload: unknown) {
    const contract = registry.get(type);
    if (!contract) throw new AppError("INTERNAL", `Unregistered event type "${type}". Register its contract first.`);
    const parsed = contract.schema.safeParse(payload);
    if (!parsed.success) throw new AppError("INTERNAL", `Event "${type}" payload violates its contract.`, { issues: parsed.error.issues.slice(0, 5) });
    return { contract, payload: parsed.data as Record<string, unknown> };
  }

  async function deliver(event: PlatformEvent, only?: string) {
    const targets = [...subscribers.entries()].filter(([name, s]) => (only ? name === only : s.type === event.type || s.type === "*"));
    for (const [name, sub] of targets) {
      try {
        await sub.handler(event);
        metrics.increment("eaop_event_deliveries_total", { type: event.type, outcome: "ok" });
      } catch (err) {
        metrics.increment("eaop_event_deliveries_total", { type: event.type, outcome: "error" });
        logger.warn("event.subscriber_failed", { type: event.type, subscriber: name, error: err instanceof Error ? err.message : String(err) });
        if (only) throw err; // inside a redelivery job: let the queue back off
        await jobs.enqueue("events.redeliver", { eventId: event.id, subscriber: name }, { organizationId: event.organizationId, idempotencyKey: `${event.id}:${name}` });
      }
    }
  }

  type OutboxRow = typeof eventOutbox.$inferSelect;
  const toEvent = (r: OutboxRow): PlatformEvent => ({
    id: r.id,
    type: r.type,
    version: r.version,
    organizationId: r.organizationId,
    occurredAt: r.occurredAt.toISOString(),
    actor: r.actorType && r.actorId ? { type: r.actorType, id: r.actorId } : null,
    correlationId: r.correlationId,
    payload: r.payload,
  });

  async function claimAndDispatch(ids: string[]) {
    if (ids.length === 0) return 0;
    const rows = await db.withSystem("events.claim", (tx) =>
      tx
        .update(eventOutbox)
        .set({ status: "dispatching", attempts: sql`${eventOutbox.attempts} + 1` })
        .where(and(inArray(eventOutbox.id, ids), inArray(eventOutbox.status, ["pending", "failed"])))
        .returning(),
    );
    for (const row of rows) {
      try {
        await deliver(toEvent(row));
        await db.withSystem("events.dispatched", (tx) => tx.update(eventOutbox).set({ status: "dispatched", dispatchedAt: new Date() }).where(eq(eventOutbox.id, row.id)));
      } catch (err) {
        const dead = row.attempts >= 10;
        await db.withSystem("events.failed", (tx) =>
          tx
            .update(eventOutbox)
            .set({ status: dead ? "dead" : "failed", lastError: redactString(String(err)).slice(0, 1000), availableAt: new Date(Date.now() + 30_000 * row.attempts) })
            .where(eq(eventOutbox.id, row.id)),
        );
      }
    }
    return rows.length;
  }

  jobs.register({
    type: "events.redeliver",
    maxAttempts: 8,
    async handle(job) {
      const { eventId, subscriber } = job.payload as { eventId: string; subscriber: string };
      const [row] = await db.withSystem("events.redeliver", (tx) => tx.select().from(eventOutbox).where(eq(eventOutbox.id, eventId)).limit(1));
      if (!row || !subscribers.has(subscriber)) return;
      await deliver(toEvent(row), subscriber);
    },
  });

  async function insert(scope: "tenant" | "system", ctx: TenantContext | null, type: string, payload: Record<string, unknown>, correlationId?: string) {
    const { contract, payload: valid } = validate(type, payload);
    const values = {
      organizationId: ctx?.organizationId ?? null,
      type,
      version: contract.version,
      payload: valid,
      actorType: ctx?.actor.type ?? "system",
      actorId: ctx?.actor.id ?? "platform",
      correlationId: ctx?.correlationId ?? correlationId ?? null,
    };
    const [row] =
      scope === "tenant" && ctx
        ? await db.withTenant(scopeOf(ctx), (tx) => tx.insert(eventOutbox).values(values).returning({ id: eventOutbox.id }))
        : await db.withSystem("events.publish_platform", (tx) => tx.insert(eventOutbox).values(values).returning({ id: eventOutbox.id }));
    const id = row!.id;
    metrics.increment("eaop_events_published_total", { type });
    // Joined transactions defer dispatch until commit; standalone ones dispatch immediately.
    await db.afterCommit(() => claimAndDispatch([id]).then(() => undefined));
    return id;
  }

  return {
    publish: (ctx, type, payload) => insert("tenant", ctx, type, payload),
    publishPlatform: (type, payload, meta) => insert("system", null, type, payload, meta?.correlationId),
    subscribe(type, name, handler) {
      if (subscribers.has(name)) throw new Error(`Event subscriber "${name}" already registered`);
      if (type !== "*" && !registry.get(type)) throw new Error(`Cannot subscribe to unregistered event "${type}"`);
      subscribers.set(name, { type, handler });
    },
    async dispatchPending(limit = 100) {
      const ids = await db.withSystem("events.scan", async (tx) => {
        // Re-queue events stuck in "dispatching" (process died after claim).
        await tx.execute(sql`update event_outbox set status = 'failed' where status = 'dispatching' and occurred_at < now() - interval '10 minutes'`);
        return tx
          .select({ id: eventOutbox.id })
          .from(eventOutbox)
          .where(and(inArray(eventOutbox.status, ["pending", "failed"]), lte(eventOutbox.availableAt, new Date())))
          .orderBy(eventOutbox.occurredAt)
          .limit(limit);
      });
      return claimAndDispatch(ids.map((r) => r.id));
    },
  };
}
