/**
 * RELEASE BLOCKER: a user from Organization A must never access Organization B data.
 * Covered at two layers:
 *   1. Database — PostgreSQL RLS (as the non-superuser runtime role).
 *   2. Services — every shared service, when called with A's context, cannot
 *      read, modify, delete or execute B's resources.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { sql } from "../../packages/db/src";
import { connectors } from "../../packages/db/src/schema";
import { type Platform } from "../../packages/platform/src";
import { addMember, createOrg, createTestPlatform, expectCode, meta, PASSWORD, systemCtx } from "../helpers/platform";
import { TEST_APP_URL } from "../helpers/env";

let p: Platform;
let A: Awaited<ReturnType<typeof createOrg>>;
let B: Awaited<ReturnType<typeof createOrg>>;
let bConnectorId: string;
let bPolicyKey: string;
let bApiKeyId: string;
let bSecretRef: string;

beforeAll(async () => {
  p = await createTestPlatform();
  A = await createOrg(p);
  B = await createOrg(p);
  // Populate B with one of everything.
  const bc = await p.connectors.create(B.adminCtx(), { type: "sandbox", name: "B secret system", authType: "api_key", config: {} });
  bConnectorId = bc.id;
  await p.connectors.setCredentials(B.adminCtx(), bc.id, { values: { apiKey: "b-super-secret-key" } });
  const pol = await p.policies.create(B.adminCtx(), { key: "b.policy", name: "B policy", kind: "access", definition: { rules: [] } });
  bPolicyKey = pol.key;
  const key = await p.apiKeys.create(B.adminCtx(), { name: "B key", scopes: ["connector.read"] });
  bApiKeyId = key.apiKey.id;
  bSecretRef = await p.secrets.put({ organizationId: B.org.id, name: "x", value: "b-secret" });
  await p.notifications.notify(systemCtx(B.org.id), { type: "core.security_alert", title: "B only", recipients: { allMembers: true } });
  await p.ai.execute(B.adminCtx(), { moduleId: "core", useCase: "test.isolation", messages: [{ role: "user", content: "B prompt" }], model: "sandbox-echo" });
  await p.connectors.create(A.adminCtx(), { type: "sandbox", name: "A system", authType: "none", config: {} });
});

afterAll(async () => {
  await p.close();
});

describe("database layer (RLS)", () => {
  it("every table with organization_id has RLS enabled AND forced", async () => {
    const res = await p.db.pool.query<{ table_name: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(`
      select c.table_name, cl.relrowsecurity, cl.relforcerowsecurity
      from information_schema.columns c
      join pg_class cl on cl.relname = c.table_name
      join pg_namespace n on n.oid = cl.relnamespace and n.nspname = 'public'
      where c.table_schema = 'public' and c.column_name = 'organization_id'`);
    expect(res.rows.length).toBeGreaterThan(20);
    const unprotected = res.rows.filter((r) => !r.relrowsecurity || !r.relforcerowsecurity).map((r) => r.table_name);
    expect(unprotected).toEqual([]);
  });

  it("the runtime role is not a superuser and cannot bypass RLS", async () => {
    const r = await p.db.pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>("select rolsuper, rolbypassrls from pg_roles where rolname = current_user");
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("an unscoped connection sees no tenant rows at all", async () => {
    const client = new pg.Client({ connectionString: TEST_APP_URL });
    await client.connect();
    try {
      for (const t of ["connectors", "memberships", "audit_events", "ai_runs", "notifications", "policies", "api_keys_metadata", "usage_events", "organizations"]) {
        const r = await client.query(`select count(*)::int as n from ${t}`);
        expect(r.rows[0].n, t).toBe(0);
      }
    } finally {
      await client.end();
    }
  });

  it("A's scope sees zero rows owned by B in every tenant table", async () => {
    const tables = (
      await p.db.pool.query<{ table_name: string }>(`select table_name from information_schema.columns where table_schema='public' and column_name='organization_id'`)
    ).rows.map((r) => r.table_name);
    for (const t of tables) {
      const n = await p.db.withTenant({ organizationId: A.org.id }, async (tx) => {
        const r = await tx.execute(sql.raw(`select count(*)::int as n from ${t} where organization_id = '${B.org.id}'`));
        return (r.rows[0] as { n: number }).n;
      });
      expect(n, `${t} leaked B rows into A's scope`).toBe(0);
    }
  });

  it("A's scope cannot insert or move rows into B", async () => {
    const err = await p.db
      .withTenant({ organizationId: A.org.id }, (tx) => tx.insert(connectors).values({ organizationId: B.org.id, type: "sandbox", name: "evil", authType: "none" }))
      .then(() => null, (e: Error & { cause?: Error }) => e);
    expect(err?.cause?.message ?? err?.message).toMatch(/row-level security/);
    // Update by id from A's scope affects nothing.
    const updated = await p.db.withTenant({ organizationId: A.org.id }, (tx) => tx.execute(sql`update connectors set name = 'pwned' where id = ${bConnectorId}`));
    expect(updated.rowCount).toBe(0);
    const deleted = await p.db.withTenant({ organizationId: A.org.id }, (tx) => tx.execute(sql`delete from connectors where id = ${bConnectorId}`));
    expect(deleted.rowCount).toBe(0);
  });

  it("tenant scope GUCs are transaction-local and never leak across pooled connections", async () => {
    await p.db.withTenant({ organizationId: B.org.id }, async () => undefined);
    const client = await p.db.pool.connect();
    try {
      const r = await client.query("select current_setting('app.current_org_id', true) as v");
      expect(r.rows[0].v ?? "").toBe("");
    } finally {
      client.release();
    }
  });
});

describe("service layer", () => {
  it("connectors: list/get/update/delete/test/execute/credentials of B fail from A", async () => {
    const a = A.adminCtx();
    const list = await p.connectors.list(a);
    expect(list.map((c) => c.id)).not.toContain(bConnectorId);
    await expectCode(p.connectors.get(a, bConnectorId), "NOT_FOUND");
    await expectCode(p.connectors.update(a, bConnectorId, { name: "pwned" }), "NOT_FOUND");
    await expectCode(p.connectors.remove(a, bConnectorId), "NOT_FOUND");
    await expectCode(p.connectors.test(a, bConnectorId), "NOT_FOUND");
    await expectCode(p.connectors.execute(a, bConnectorId, { capability: "records.list", operation: "list" }), "NOT_FOUND");
    await expectCode(p.connectors.setCredentials(a, bConnectorId, { values: { apiKey: "x" } }), "NOT_FOUND");
    await expectCode(p.connectors.rotateCredentials(a, bConnectorId, { apiKey: "x" }), "CONFLICT"); // no ACTIVE credential visible in A
  });

  it("secrets: A cannot resolve B's secret reference", async () => {
    await expectCode(p.secrets.get(bSecretRef, A.org.id), "FORBIDDEN");
    await expectCode(p.secrets.rotate(bSecretRef, A.org.id, "x"), "FORBIDDEN");
    await expectCode(p.secrets.destroy(bSecretRef, A.org.id), "FORBIDDEN");
    expect(await p.secrets.get(bSecretRef, B.org.id)).toBe("b-secret");
  });

  it("policies, API keys, audit, AI runs, notifications, usage, members stay within A", async () => {
    const a = A.adminCtx();
    expect((await p.policies.list(a)).map((x) => x.key)).not.toContain(bPolicyKey);
    await expectCode(p.policies.get(a, bPolicyKey), "NOT_FOUND");
    await expectCode(p.policies.activate(a, bPolicyKey, 1), "NOT_FOUND");
    expect((await p.apiKeys.list(a)).map((k) => k.id)).not.toContain(bApiKeyId);
    await expectCode(p.apiKeys.revoke(a, bApiKeyId), "NOT_FOUND");
    const audit = await p.audit.query(a, { limit: 500 });
    expect(audit.data.every((e) => e.organizationId === A.org.id)).toBe(true);
    expect(audit.data.some((e) => e.resourceId === bConnectorId)).toBe(false);
    const runs = await p.ai.listRuns(a, {});
    expect(runs.data).toHaveLength(0);
    const notes = await p.notifications.listMine(a, {});
    expect(notes.data.some((n) => n.title === "B only")).toBe(false);
    const usage = await p.usage.summary(a, { from: new Date(0), to: new Date(Date.now() + 86_400_000), groupBy: "metric" });
    expect(usage.find((u) => u.metric === "ai.runs")).toBeUndefined();
    const members = await p.organizations.listMembers(a);
    expect(members.map((m) => m.userId)).toEqual([A.admin.id]);
  });

  it("roles: A cannot assign roles to B's memberships or see B's custom roles", async () => {
    await p.rbac.roles.createRole(B.adminCtx(), { key: "b_custom", name: "B custom", permissions: ["org.read"] });
    const roles = await p.rbac.roles.listRoles(A.adminCtx());
    expect(roles.map((r) => r.key)).not.toContain("b_custom");
    const bMembers = await p.organizations.listMembers(B.adminCtx());
    await expectCode(p.rbac.roles.assign(A.adminCtx(), { membershipId: bMembers[0]!.membershipId, roleKey: "read_only" }), "NOT_FOUND");
    await expectCode(p.organizations.setMemberStatus(A.adminCtx(), bMembers[0]!.membershipId, "suspended"), "NOT_FOUND");
  });

  it("search never returns B's resources", async () => {
    const res = await p.search.query(A.adminCtx(), "secret system");
    expect(res.hits.map((h) => h.id)).not.toContain(bConnectorId);
    const resB = await p.search.query(B.adminCtx(), "secret system");
    expect(resB.hits.map((h) => h.id)).toContain(bConnectorId);
  });

  it("sessions: a user of A cannot switch into B (indistinguishable from non-existent)", async () => {
    const login = await p.auth.login({ email: A.admin.email, password: PASSWORD }, meta());
    await expectCode(p.auth.switchOrganization(login.token, B.org.id, meta()), "NOT_FOUND");
    const resolved = await p.auth.resolve(login.token, meta());
    expect(resolved?.tenant?.organizationId).toBe(A.org.id);
  });

  it("API keys are bound to their own organization", async () => {
    const { key } = await p.apiKeys.create(B.adminCtx(), { name: "B read", scopes: ["connector.read"] });
    const auth = await p.apiKeys.authenticate(key);
    expect(auth?.organizationId).toBe(B.org.id);
    const ctx = { organizationId: auth!.organizationId, actor: auth!.actor, ...meta(), cache: new Map() };
    const list = await p.connectors.list(ctx);
    expect(list.every((c) => c.id !== undefined)).toBe(true);
    expect((await p.connectors.list(ctx)).map((c) => c.name)).not.toContain("A system");
  });

  it("a member of BOTH orgs only sees the active org's data", async () => {
    const shared = await addMember(p, A.org.id, ["org_admin"]);
    await addMember(p, B.org.id, ["read_only"], shared.user);
    const inA = await p.connectors.list(shared.ctx());
    expect(inA.map((c) => c.id)).not.toContain(bConnectorId);
    // In B the same user has read_only: cannot read connectors at all.
    await expectCode(p.connectors.list({ ...shared.ctx(), organizationId: B.org.id, cache: new Map() }), "FORBIDDEN");
  });
});
