import { randomUUID } from "node:crypto";
import { and, eq, eventOutbox, scopeOf, sql, webhooks, type Database } from "@eaop/db";
import { type JobQueue } from "@eaop/jobs";
import { type Logger } from "@eaop/observability";
import { type SecretStore } from "@eaop/secrets";
import { assertSafeOutboundUrl, hmacSha256, randomToken, type UrlGuardOptions } from "@eaop/security";
import { AppError, notFound, type TenantContext } from "@eaop/shared-types";
import { type EventBus } from "./bus";
import { type EventRegistry } from "./contracts";

export const WEBHOOK_SIGNATURE_HEADER = "x-eaop-signature";
const MAX_CONSECUTIVE_FAILURES = 20;

/** Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${body}`)> */
export function signWebhook(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${hmacSha256(secret, `${timestamp}.${body}`)}`;
}

export interface WebhookView {
  id: string;
  url: string;
  description: string | null;
  eventTypes: string[];
  status: string;
  consecutiveFailures: number;
  lastDeliveryAt: string | null;
  lastDeliveryStatus: number | null;
  createdAt: string;
}

export interface WebhookService {
  /** Returns the signing secret ONCE; only its reference is stored. */
  create(ctx: TenantContext, input: { url: string; eventTypes: string[]; description?: string }): Promise<{ webhook: WebhookView; signingSecret: string }>;
  list(ctx: TenantContext): Promise<WebhookView[]>;
  remove(ctx: TenantContext, id: string): Promise<void>;
}

export function createWebhookService(deps: {
  db: Database;
  bus: EventBus;
  registry: EventRegistry;
  jobs: JobQueue;
  secrets: SecretStore;
  logger: Logger;
  urlGuard: UrlGuardOptions;
  fetchImpl?: typeof fetch;
}): WebhookService {
  const { db, registry, jobs, secrets, logger } = deps;
  const doFetch = deps.fetchImpl ?? fetch;

  const view = (r: typeof webhooks.$inferSelect): WebhookView => ({
    id: r.id,
    url: r.url,
    description: r.description,
    eventTypes: r.eventTypes,
    status: r.status,
    consecutiveFailures: r.consecutiveFailures,
    lastDeliveryAt: r.lastDeliveryAt?.toISOString() ?? null,
    lastDeliveryStatus: r.lastDeliveryStatus,
    createdAt: r.createdAt.toISOString(),
  });

  // Fan-out: every tenant event → matching active webhooks → one delivery job each.
  deps.bus.subscribe("*", "core.webhooks.fanout", async (event) => {
    if (!event.organizationId) return;
    const contract = registry.get(event.type);
    if (contract?.externallyVisible === false) return;
    const hooks = await db.withTenant({ organizationId: event.organizationId }, (tx) =>
      tx
        .select({ id: webhooks.id })
        .from(webhooks)
        .where(and(eq(webhooks.status, "active"), sql`(${event.type} = any(${webhooks.eventTypes}) or '*' = any(${webhooks.eventTypes}))`)),
    );
    for (const h of hooks) {
      await jobs.enqueue("webhooks.deliver", { webhookId: h.id, eventId: event.id }, { organizationId: event.organizationId, idempotencyKey: `${h.id}:${event.id}` });
    }
  });

  jobs.register({
    type: "webhooks.deliver",
    maxAttempts: 8,
    timeoutMs: 15_000,
    async handle(job) {
      const { webhookId, eventId } = job.payload as { webhookId: string; eventId: string };
      const orgId = job.organizationId!;
      const [hook] = await db.withTenant({ organizationId: orgId }, (tx) => tx.select().from(webhooks).where(eq(webhooks.id, webhookId)).limit(1));
      if (!hook || hook.status !== "active") return;
      const [ev] = await db.withTenant({ organizationId: orgId }, (tx) => tx.select().from(eventOutbox).where(eq(eventOutbox.id, eventId)).limit(1));
      if (!ev) return;
      await assertSafeOutboundUrl(hook.url, deps.urlGuard);
      const body = JSON.stringify({ id: ev.id, type: ev.type, version: ev.version, occurredAt: ev.occurredAt.toISOString(), organizationId: ev.organizationId, data: ev.payload });
      const secret = await secrets.get(hook.signingSecretRef, orgId);
      let status = 0;
      try {
        const res = await doFetch(hook.url, {
          method: "POST",
          redirect: "manual",
          headers: { "content-type": "application/json", "x-eaop-event": ev.type, "x-eaop-delivery": randomUUID(), [WEBHOOK_SIGNATURE_HEADER]: signWebhook(secret, body) },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        status = res.status;
      } catch (err) {
        logger.warn("webhook.delivery_error", { webhookId, error: (err as Error).message });
      }
      const ok = status >= 200 && status < 300;
      await db.withTenant({ organizationId: orgId }, (tx) =>
        tx
          .update(webhooks)
          .set({
            lastDeliveryAt: new Date(),
            lastDeliveryStatus: status,
            consecutiveFailures: ok ? 0 : sql`${webhooks.consecutiveFailures} + 1`,
            status: !ok && hook.consecutiveFailures + 1 >= MAX_CONSECUTIVE_FAILURES ? "disabled" : hook.status,
          })
          .where(eq(webhooks.id, webhookId)),
      );
      if (!ok) throw new AppError("UPSTREAM_ERROR", `Webhook endpoint responded ${status || "with a network error"}`, undefined, { retryable: true });
    },
  });

  return {
    async create(ctx, input) {
      await assertSafeOutboundUrl(input.url, deps.urlGuard);
      for (const t of input.eventTypes) {
        if (t !== "*" && !registry.get(t)) throw new AppError("VALIDATION_FAILED", `Unknown event type "${t}".`);
      }
      const signingSecret = `whsec_${randomToken(24)}`;
      const ref = await secrets.put({ organizationId: ctx.organizationId, name: "webhook-signing", value: signingSecret });
      const [row] = await db.withTenant(scopeOf(ctx), (tx) =>
        tx
          .insert(webhooks)
          .values({ organizationId: ctx.organizationId, url: input.url, eventTypes: input.eventTypes, description: input.description ?? null, signingSecretRef: ref, createdBy: ctx.actor.type === "user" ? ctx.actor.id : null })
          .returning(),
      );
      return { webhook: view(row!), signingSecret };
    },
    async list(ctx) {
      const rows = await db.withTenant(scopeOf(ctx), (tx) => tx.select().from(webhooks).where(eq(webhooks.organizationId, ctx.organizationId)));
      return rows.map(view);
    },
    async remove(ctx, id) {
      const [row] = await db.withTenant(scopeOf(ctx), (tx) => tx.delete(webhooks).where(eq(webhooks.id, id)).returning());
      if (!row) throw notFound("Webhook", id);
      await secrets.destroy(row.signingSecretRef, ctx.organizationId).catch(() => undefined);
    },
  };
}
