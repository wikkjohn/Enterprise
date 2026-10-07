import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "../../packages/db/src";
import { createOrg, createTestPlatform } from "../helpers/platform";

/**
 * Confirms the per-organization database access rules hold under the actual
 * runtime role (the integration suite connects as eaop_app, a NOSUPERUSER
 * NOBYPASSRLS role — the production posture). A misconfigured role or an
 * unprotected table would silently bypass tenant isolation; these assertions
 * fail loudly if that regresses.
 */
type P = Awaited<ReturnType<typeof createTestPlatform>>;
let p: P;

beforeAll(async () => {
  p = await createTestPlatform();
});
afterAll(() => p.close());

const raw = <T = Record<string, unknown>>(q: ReturnType<typeof sql>) => p.db.withSystem("test.catalog", (tx) => tx.execute(q)) as Promise<{ rows: T[] }>;

describe("Database role is least-privilege", () => {
  it("the connected role is not a superuser and cannot bypass RLS", async () => {
    const { rows } = await raw<{ super: boolean; bypassrls: boolean; rolname: string }>(sql`
      select rolsuper as super, rolbypassrls as bypassrls, current_user as rolname
      from pg_roles where rolname = current_user`);
    expect(rows[0]).toMatchObject({ super: false, bypassrls: false });
  });

  it("the connected role owns no application table (so it cannot DISABLE RLS)", async () => {
    const { rows } = await raw<{ relname: string }>(sql`
      select c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      where c.relkind = 'r' and pg_get_userbyid(c.relowner) = current_user`);
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it("cannot turn off row-level security on a tenant table", async () => {
    await expect(raw(sql`alter table organizations disable row level security`)).rejects.toThrow();
    await expect(raw(sql`alter table ai_runs no force row level security`)).rejects.toThrow();
  });
});

describe("Every tenant table is protected", () => {
  it("every table with an organization_id column has RLS enabled AND forced", async () => {
    const { rows } = await raw<{ relname: string }>(sql`
      select c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped
      where c.relkind = 'r' and not (c.relrowsecurity and c.relforcerowsecurity)`);
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it("no RLS-enabled table is left without a policy", async () => {
    const { rows } = await raw<{ relname: string }>(sql`
      select c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      where c.relkind = 'r' and c.relrowsecurity
        and not exists (select 1 from pg_policy pol where pol.polrelid = c.oid)`);
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it("identity tables holding no organization_id are still owner/co-member scoped (users, sessions, auth_tokens)", async () => {
    const { rows } = await raw<{ relname: string }>(sql`
      select c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      where c.relkind = 'r' and c.relname in ('users','sessions','auth_tokens','memberships')
        and not (c.relrowsecurity and c.relforcerowsecurity)`);
    expect(rows.map((r) => r.relname)).toEqual([]);
  });
});

describe("RLS enforces tenant scope functionally under the runtime role", () => {
  it("a tenant transaction sees only its own organization's rows", async () => {
    const A = await createOrg(p);
    const B = await createOrg(p);
    // Each org writes a connector in its own scope.
    const cA = await p.connectors.create(A.adminCtx(), { type: "sandbox", name: "A-conn", authType: "none", config: {} });
    await p.connectors.create(B.adminCtx(), { type: "sandbox", name: "B-conn", authType: "none", config: {} });
    // A, scoped to its own tenant, must not see B's connector and vice versa.
    const aList = await p.connectors.list(A.adminCtx());
    const bList = await p.connectors.list(B.adminCtx());
    expect(aList.some((c) => c.id === cA.id)).toBe(true);
    expect(bList.some((c) => c.id === cA.id)).toBe(false);
    // Direct SELECT in A's scope returns only A's rows at the database layer.
    const rows = await p.db.withTenant({ organizationId: A.org.id }, (tx) =>
      tx.execute(sql`select count(*)::int as n from connectors where organization_id <> ${A.org.id}`),
    );
    expect((rows.rows[0] as { n: number }).n).toBe(0);
  });

  it("a session-level system GUC (a hypothetical leak on a pooled connection) is overridden by the per-transaction reset", async () => {
    const A = await createOrg(p);
    const B = await createOrg(p);
    await p.connectors.create(B.adminCtx(), { type: "sandbox", name: "B-only", authType: "none", config: {} });
    // Simulate a leaked session-level system flag, then run a normal tenant transaction for A.
    const client = await p.db.pool.connect();
    try {
      await client.query("select set_config('app.system_context','on',false)"); // leak (is_local = false)
      // The app always resets all three GUCs transaction-locally (packages/db/src/client.ts).
      await client.query("begin");
      await client.query("select set_config('app.current_org_id',$1,true), set_config('app.current_user_id','',true), set_config('app.system_context','',true)", [A.org.id]);
      const r = await client.query("select count(*)::int as n from connectors");
      await client.query("commit");
      // A has no connectors; B's row must not be visible despite the leaked flag.
      expect(r.rows[0].n).toBe(0);
    } finally {
      await client.query("select set_config('app.system_context','',false)").catch(() => undefined);
      client.release();
    }
  });
});
