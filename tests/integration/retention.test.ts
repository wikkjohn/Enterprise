import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aiRuns, eq, notifications } from "../../packages/db/src";
import { runRetention, type Platform } from "../../packages/platform/src";
import { createOrg, createTestPlatform, systemCtx } from "../helpers/platform";

let p: Platform;
beforeAll(async () => {
  p = await createTestPlatform();
});
afterAll(() => p.close());

describe("data retention", () => {
  it("purges per each tenant's own settings and never touches recent audit history", async () => {
    const short = await createOrg(p);
    const long = await createOrg(p);
    await p.organizations.updateRetention(short.adminCtx(), { aiRunDays: 7, notificationDays: 7 });
    for (const o of [short, long]) {
      await p.ai.execute(o.adminCtx(), { moduleId: "core", useCase: "test.retention", messages: [{ role: "user", content: "x" }], model: "sandbox-echo" });
      await p.notifications.notify(systemCtx(o.org.id), { type: "core.security_alert", title: "old", recipients: { allMembers: true } });
      // Age the rows by 30 days.
      await p.db.withTenant({ organizationId: o.org.id }, async (tx) => {
        await tx.update(aiRuns).set({ createdAt: new Date(Date.now() - 30 * 86_400_000) }).where(eq(aiRuns.organizationId, o.org.id));
        await tx.update(notifications).set({ createdAt: new Date(Date.now() - 30 * 86_400_000) }).where(eq(notifications.organizationId, o.org.id));
      });
    }
    const auditBefore = (await p.audit.query(short.adminCtx(), { limit: 500 })).data.length;
    await runRetention(p);
    expect((await p.ai.listRuns(short.adminCtx(), {})).data).toHaveLength(0); // 7-day policy
    expect((await p.ai.listRuns(long.adminCtx(), {})).data).toHaveLength(1); // default 365 days
    expect((await p.notifications.listMine(short.adminCtx(), {})).data).toHaveLength(0);
    expect((await p.notifications.listMine(long.adminCtx(), {})).data.length).toBeGreaterThan(0);
    expect((await p.audit.query(short.adminCtx(), { limit: 500 })).data.length).toBeGreaterThanOrEqual(auditBefore);
  });
});

describe("platform administration", () => {
  it("only platform admins can provision and list organizations", async () => {
    const nonAdmin = { actor: { type: "user" as const, id: "x", label: "x" }, correlationId: "c" };
    await expect(p.organizations.listAll(nonAdmin)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const admin = { actor: { type: "user" as const, id: "y", label: "y", isPlatformAdmin: true }, correlationId: "c" };
    const all = await p.organizations.listAll(admin);
    expect(all.length).toBeGreaterThan(0);
  });
});
