import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents, sql } from "../../packages/db/src";
import { type Platform } from "../../packages/platform/src";
import { createOrg, createTestPlatform, meta, PASSWORD } from "../helpers/platform";

let p: Platform;
let O: Awaited<ReturnType<typeof createOrg>>;

beforeAll(async () => {
  p = await createTestPlatform();
  O = await createOrg(p);
});
afterAll(() => p.close());

describe("audit log", () => {
  it("is append-only for the runtime role, even with system scope", async () => {
    await p.audit.record(O.adminCtx(), { action: "test.event" });
    const upd = await p.db.withSystem("t", (tx) => tx.execute(sql`update audit_events set action = 'tampered' where organization_id = ${O.org.id}`)).then(() => "ok", (e: Error & { cause?: Error }) => e.cause?.message ?? e.message);
    expect(upd).toMatch(/permission denied|append-only/);
    const del = await p.db.withSystem("t", (tx) => tx.delete(auditEvents)).then(() => "ok", (e: Error & { cause?: Error }) => e.cause?.message ?? e.message);
    expect(del).toMatch(/permission denied|append-only/);
  });

  it("retention purge refuses to delete anything newer than 90 days", async () => {
    const r = await p.db.withSystem("t", (tx) => tx.execute(sql`select eaop_purge_audit_events(${O.org.id}::uuid, now())`)).then(() => "ok", (e: Error & { cause?: Error }) => e.cause?.message ?? e.message);
    expect(r).toMatch(/retention floor/);
  });

  it("captures who/what/when/where with before/after and redacts secrets", async () => {
    const c = await p.connectors.create(O.adminCtx(), { type: "sandbox", name: "audited", authType: "api_key", config: {} });
    await p.connectors.setCredentials(O.adminCtx(), c.id, { values: { apiKey: "sk-should-never-appear-in-audit-1234567890" } });
    await p.connectors.update(O.adminCtx(), c.id, { name: "audited-2" });
    const log = await p.audit.query(O.adminCtx(), { resourceId: c.id, limit: 50 });
    const actions = log.data.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["connector.created", "connector.credential_set", "connector.updated"]));
    const upd = log.data.find((e) => e.action === "connector.updated")!;
    expect(upd).toMatchObject({ actorId: O.admin.id, actorType: "user", ip: "203.0.113.10", outcome: "success" });
    expect(upd.before).toMatchObject({ name: "audited" });
    expect(upd.after).toMatchObject({ name: "audited-2" });
    expect(upd.correlationId).toBeTruthy();
    expect(JSON.stringify(log.data)).not.toContain("sk-should-never-appear");
  });

  it("records logins, setting changes and module/admin actions", async () => {
    await p.auth.login({ email: O.admin.email, password: PASSWORD }, meta());
    await p.organizations.updateRetention(O.adminCtx(), { aiPromptRetention: "none" });
    const actions = (await p.audit.query(O.adminCtx(), { limit: 200 })).data.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["auth.login", "organization.settings_changed", "organization.created"]));
  });

  it("supports filtering and keyset pagination", async () => {
    for (let i = 0; i < 7; i++) await p.audit.record(O.adminCtx(), { action: "test.paged", resourceId: String(i) });
    const first = await p.audit.query(O.adminCtx(), { action: "test.paged", limit: 3 });
    const second = await p.audit.query(O.adminCtx(), { action: "test.paged", limit: 3, cursor: first.nextCursor });
    const third = await p.audit.query(O.adminCtx(), { action: "test.paged", limit: 3, cursor: second.nextCursor });
    const ids = [...first.data, ...second.data, ...third.data].map((e) => e.resourceId);
    expect(new Set(ids).size).toBe(7);
    expect(third.nextCursor).toBeUndefined();
  });
});
