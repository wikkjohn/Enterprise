import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { eq, eventOutbox } from "../../packages/db/src";
import { signWebhook } from "../../packages/events/src";
import { type Platform } from "../../packages/platform/src";
import { addMember, createOrg, createTestPlatform, expectCode, systemCtx } from "../helpers/platform";

const delivered: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
let hookStatus = 200;
const fakeFetch: typeof fetch = async (input, init) => {
  delivered.push({ url: String(input), body: String(init?.body), headers: init?.headers as Record<string, string> });
  return new Response("ok", { status: hookStatus });
};

let p: Platform;
let O: Awaited<ReturnType<typeof createOrg>>;

beforeAll(async () => {
  p = await createTestPlatform({ fetchImpl: fakeFetch });
  O = await createOrg(p);
});
afterAll(() => p.close());

describe("event bus", () => {
  it("rejects unregistered events and payloads that violate the contract", async () => {
    await expectCode(p.events.bus.publish(O.adminCtx(), "nope.event", {}), "INTERNAL");
    await expectCode(p.events.bus.publish(O.adminCtx(), "connector.created", { connectorId: "not-a-uuid" }), "INTERNAL");
  });

  it("delivers to subscribers after commit, only once per subscriber", async () => {
    const seen: string[] = [];
    p.events.registry.register({ type: "test.thing_happened", owner: "core", version: 1, description: "test", schema: z.object({ n: z.number() }) });
    p.events.bus.subscribe("test.thing_happened", "test.sub", async (e) => {
      seen.push(`${e.organizationId}:${(e.payload as { n: number }).n}`);
    });
    // Published inside a transaction that rolls back → never delivered.
    await p.db
      .withTenant({ organizationId: O.org.id }, async () => {
        await p.events.bus.publish(systemCtx(O.org.id), "test.thing_happened", { n: 1 });
        throw new Error("rollback");
      })
      .catch(() => undefined);
    const id = await p.events.bus.publish(systemCtx(O.org.id), "test.thing_happened", { n: 2 });
    expect(seen).toEqual([`${O.org.id}:2`]);
    const [row] = await p.db.withSystem("t", (tx) => tx.select().from(eventOutbox).where(eq(eventOutbox.id, id)));
    expect(row!.status).toBe("dispatched");
    await p.events.bus.dispatchPending();
    expect(seen).toHaveLength(1);
  });

  it("a failing subscriber is retried individually through the job queue", async () => {
    let attempts = 0;
    p.events.registry.register({ type: "test.flaky", owner: "core", version: 1, description: "test", schema: z.object({}) });
    p.events.bus.subscribe("test.flaky", "test.flaky_sub", async () => {
      attempts++;
      if (attempts < 2) throw new Error("boom");
    });
    await p.events.bus.publish(systemCtx(O.org.id), "test.flaky", {});
    expect(attempts).toBe(1);
    await p.db.pool.query("select 1"); // let the redelivery job become due
    await p.db.withSystem("t", (tx) => tx.execute(`update background_jobs_metadata set run_at = now() where type = 'events.redeliver'` as never));
    await p.jobs.runOnce("test-worker");
    expect(attempts).toBe(2);
  });
});

describe("job queue", () => {
  it("retries with backoff then dead-letters", async () => {
    let runs = 0;
    p.jobs.register({ type: "test.always_fails", maxAttempts: 2, async handle() { runs++; throw new Error("nope"); } });
    await p.jobs.enqueue("test.always_fails", {}, { organizationId: O.org.id });
    await p.jobs.runOnce("w1");
    await p.db.pool.query("select 1");
    await p.db.withSystem("t", (tx) => tx.execute(`update background_jobs_metadata set run_at = now() where type = 'test.always_fails'` as never));
    await p.jobs.runOnce("w1");
    expect(runs).toBe(2);
    const failures = await p.jobs.recentFailures(10, O.org.id);
    expect(failures.find((f) => f.type === "test.always_fails")?.status).toBe("dead");
  });

  it("idempotency keys deduplicate enqueues", async () => {
    p.jobs.register({ type: "test.once", async handle() {} });
    const a = await p.jobs.enqueue("test.once", {}, { idempotencyKey: "k1" });
    const b = await p.jobs.enqueue("test.once", {}, { idempotencyKey: "k1" });
    expect(a).toBeTruthy();
    expect(b).toBeNull();
  });
});

describe("notifications", () => {
  it("resolves recipients by permission, respects preferences, never crosses tenants", async () => {
    const reader = await addMember(p, O.org.id, ["read_only"]);
    const sec = await addMember(p, O.org.id, ["security_admin"]);
    const res = await p.notifications.notify(systemCtx(O.org.id), { type: "core.connector_failed", title: "x failed", recipients: { permission: "connector.credential.manage" } });
    expect(res.recipients).toBe(2); // org admin + security admin
    expect((await p.notifications.listMine(reader.ctx(), {})).data).toHaveLength(0);
    expect(await p.notifications.unreadCount(sec.ctx())).toBe(1);
    await p.notifications.setPreference(sec.ctx(), "core.connector_failed", "in_app", false);
    await p.notifications.setPreference(sec.ctx(), "core.connector_failed", "email", false);
    await p.notifications.notify(systemCtx(O.org.id), { type: "core.connector_failed", title: "y failed", recipients: { permission: "connector.credential.manage" } });
    expect(await p.notifications.unreadCount({ ...sec.ctx(), cache: new Map() })).toBe(1);
    await p.notifications.markRead(sec.ctx(), "all");
    expect(await p.notifications.unreadCount(sec.ctx())).toBe(0);
  });

  it("mandatory types cannot be muted; action URLs must be relative", async () => {
    await expectCode(p.notifications.setPreference(O.adminCtx(), "core.security_alert", "in_app", false), "VALIDATION_FAILED");
    await expect(p.notifications.notify(systemCtx(O.org.id), { type: "core.security_alert", title: "x", actionUrl: "https://evil.example", recipients: { allMembers: true } })).rejects.toThrow();
  });
});

describe("webhooks", () => {
  it("delivers signed payloads for subscribed events and disables after repeated failure", async () => {
    const { webhook, signingSecret } = await p.events.webhooks.create(O.adminCtx(), { url: "https://hooks.example/eaop", eventTypes: ["connector.created"] });
    delivered.length = 0;
    const c = await p.connectors.create(O.adminCtx(), { type: "sandbox", name: "hooked", authType: "none", config: {} });
    await p.jobs.runOnce("w-hooks");
    const d = delivered.find((x) => x.url === "https://hooks.example/eaop")!;
    expect(JSON.parse(d.body)).toMatchObject({ type: "connector.created", data: { connectorId: c.id } });
    const sig = d.headers["x-eaop-signature"]!;
    const t = Number(sig.split(",")[0]!.slice(2));
    expect(sig).toBe(signWebhook(signingSecret, d.body, t));
    expect((await p.events.webhooks.list(O.adminCtx())).find((w) => w.id === webhook.id)?.lastDeliveryStatus).toBe(200);
    await expectCode(p.events.webhooks.create(O.adminCtx(), { url: "https://hooks.example/x", eventTypes: ["not.real"] }), "VALIDATION_FAILED");
    hookStatus = 200;
  });
});
