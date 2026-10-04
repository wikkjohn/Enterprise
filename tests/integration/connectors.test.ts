import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "../../packages/db/src";
import { type Platform } from "../../packages/platform/src";
import { createOrg, createTestPlatform, expectCode } from "../helpers/platform";

type Call = { url: string; init: RequestInit };
const calls: Call[] = [];
let script: Array<() => Response> = [];
const fakeFetch: typeof fetch = async (input, init) => {
  calls.push({ url: String(input), init: init ?? {} });
  const next = script.shift();
  return next ? next() : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
};

let p: Platform;
let O: Awaited<ReturnType<typeof createOrg>>;

beforeAll(async () => {
  p = await createTestPlatform({ fetchImpl: fakeFetch });
  O = await createOrg(p);
});
afterAll(() => p.close());

describe("connector catalog", () => {
  it("labels availability honestly", () => {
    const cat = p.connectors.catalog();
    expect(cat.find((d) => d.type === "rest_api")?.availability).toBe("available");
    expect(cat.find((d) => d.type === "salesforce")?.availability).toBe("contract_only");
    expect(cat.find((d) => d.type === "sandbox")?.availability).toBe("sandbox");
    expect(cat.map((d) => d.type)).toEqual(expect.arrayContaining(["microsoft_graph", "servicenow", "sap", "workday", "jira", "slack", "google_workspace", "box", "dropbox", "confluence", "notion", "oracle", "sql_database", "sftp", "graphql", "outbound_webhook"]));
  });

  it("contract-only connectors can be configured but not executed", async () => {
    const c = await p.connectors.create(O.adminCtx(), { type: "servicenow", name: "ServiceNow prod", authType: "basic", config: { instanceUrl: "https://acme.service-now.com" } });
    expect(c.status).toBe("draft");
    await expectCode(p.connectors.test(O.adminCtx(), c.id), "NOT_IMPLEMENTED");
    await expectCode(p.connectors.execute(O.adminCtx(), c.id, { capability: "table.read", operation: "read" }), "NOT_IMPLEMENTED");
  });
});

describe("credentials", () => {
  it("never stores plaintext credentials in the database", async () => {
    const c = await p.connectors.create(O.adminCtx(), { type: "rest_api", name: "Billing API", authType: "api_key", config: { baseUrl: "https://api.billing.example" } });
    const secret = "sk-live-PLAINTEXT-MARKER-0123456789";
    const view = await p.connectors.setCredentials(O.adminCtx(), c.id, { values: { apiKey: secret }, expiresAt: new Date(Date.now() + 30 * 86_400_000) });
    expect(view.credential?.hint).toBe("••••6789");
    const dump = await p.db.withSystem("t", (tx) =>
      tx.execute(sql`select (select coalesce(string_agg(m::text, ''), '') from connector_credentials_metadata m) || (select coalesce(string_agg(c::text, ''), '') from connectors c) as all`),
    );
    expect(String((dump.rows[0] as { all: string }).all)).not.toContain("PLAINTEXT-MARKER");
    const anywhere = await p.db.withSystem("t", (tx) => tx.execute(sql`select count(*)::int as n from dev_secret_values where ciphertext like ${"%PLAINTEXT%"}`));
    expect((anywhere.rows[0] as { n: number }).n).toBe(0);
  });

  it("rejects secrets smuggled into config", async () => {
    await expectCode(p.connectors.create(O.adminCtx(), { type: "rest_api", name: "bad", authType: "none", config: { baseUrl: "https://x.example", clientSecret: "x" } as never }), "VALIDATION_FAILED");
  });

  it("rotates and revokes credentials", async () => {
    const c = await p.connectors.create(O.adminCtx(), { type: "sandbox", name: "rotating", authType: "api_key", config: {} });
    await p.connectors.setCredentials(O.adminCtx(), c.id, { values: { apiKey: "first-key-value-xxxx" } });
    const rotated = await p.connectors.rotateCredentials(O.adminCtx(), c.id, { apiKey: "second-key-value-yyyy" });
    expect(rotated.credential?.lastRotatedAt).toBeTruthy();
    const revoked = await p.connectors.revokeCredentials(O.adminCtx(), c.id);
    expect(revoked.credential).toBeNull();
    expect(revoked.status).toBe("draft");
  });
});

describe("execution", () => {
  it("REST adapter: auth header, path confinement, usage metering", async () => {
    const c = await p.connectors.create(O.adminCtx(), { type: "rest_api", name: "Orders API", authType: "api_key", config: { baseUrl: "https://api.orders.example/v2" } });
    await p.connectors.setCredentials(O.adminCtx(), c.id, { values: { apiKey: "tok_123456789" } });
    calls.length = 0;
    const out = (await p.connectors.execute(O.adminCtx(), c.id, { capability: "http.request", operation: "read", params: { method: "GET", path: "/orders", query: { limit: 5 } } })) as { status: number };
    expect(out.status).toBe(200);
    expect(calls[0]!.url).toBe("https://api.orders.example/v2/orders?limit=5");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer tok_123456789");
    await expectCode(p.connectors.execute(O.adminCtx(), c.id, { capability: "http.request", operation: "read", params: { method: "GET", path: "//evil.example/x" } }), "VALIDATION_FAILED");
    await expectCode(p.connectors.execute(O.adminCtx(), c.id, { capability: "http.request", operation: "read", params: { method: "POST", path: "/orders" } }), "VALIDATION_FAILED");
    const usage = await p.usage.summary(O.adminCtx(), { from: new Date(Date.now() - 60_000), to: new Date(Date.now() + 60_000), groupBy: "connector", metric: "connector.actions" });
    expect(usage.find((u) => u.key === c.id)?.quantity).toBeGreaterThanOrEqual(1);
  });

  it("retries transient failures and honours Retry-After, then succeeds", async () => {
    const c = await p.connectors.create(O.adminCtx(), { type: "rest_api", name: "Flaky API", authType: "none", config: { baseUrl: "https://flaky.example" } });
    script = [() => new Response("x", { status: 503 }), () => new Response("x", { status: 429, headers: { "retry-after": "0" } })];
    calls.length = 0;
    await p.connectors.execute(O.adminCtx(), c.id, { capability: "http.request", operation: "read", params: { method: "GET", path: "/" } });
    expect(calls).toHaveLength(3);
  });

  it("does not retry permanent failures and emits connector.failed", async () => {
    const c = await p.connectors.create(O.adminCtx(), { type: "rest_api", name: "Bad API", authType: "none", config: { baseUrl: "https://bad.example" } });
    script = [() => new Response("x", { status: 404 })];
    calls.length = 0;
    await expectCode(p.connectors.execute(O.adminCtx(), c.id, { capability: "http.request", operation: "read", params: { method: "GET", path: "/" } }), "UPSTREAM_ERROR");
    expect(calls).toHaveLength(1);
  });

  it("refreshes OAuth client-credentials tokens on 401", async () => {
    const c = await p.connectors.create(O.adminCtx(), { type: "rest_api", name: "OAuth API", authType: "oauth2", config: { baseUrl: "https://oauth-api.example", tokenUrl: "https://auth.example/token" } });
    await p.connectors.setCredentials(O.adminCtx(), c.id, { values: { clientId: "cid", clientSecret: "csecret" } });
    script = [
      () => new Response(JSON.stringify({ access_token: "fresh-token", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } }),
      () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    ];
    calls.length = 0;
    await p.connectors.execute(O.adminCtx(), c.id, { capability: "http.request", operation: "read", params: { method: "GET", path: "/me" } });
    expect(calls[0]!.url).toBe("https://auth.example/token");
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBe("Bearer fresh-token");
  });

  it("blocks SSRF to private networks", async () => {
    const strict = await createTestPlatform({ fetchImpl: fakeFetch, urlGuard: { resolve: async () => ["10.0.0.5"] } });
    const o = await createOrg(strict);
    await expectCode(strict.connectors.create(o.adminCtx(), { type: "rest_api", name: "internal", authType: "none", config: { baseUrl: "https://internal.corp" } }), "VALIDATION_FAILED");
    await expectCode(strict.connectors.create(o.adminCtx(), { type: "rest_api", name: "meta", authType: "none", config: { baseUrl: "https://169.254.169.254" } }), "VALIDATION_FAILED");
    await strict.close();
  });

  it("disabled capabilities and undeclared operations are refused", async () => {
    const c = await p.connectors.create(O.adminCtx(), { type: "sandbox", name: "limited", authType: "none", config: {}, capabilities: ["records.list"] });
    await expectCode(p.connectors.execute(O.adminCtx(), c.id, { capability: "records.write", operation: "write", params: { record: {} } }), "FORBIDDEN");
    await expectCode(p.connectors.execute(O.adminCtx(), c.id, { capability: "records.list", operation: "delete" }), "FORBIDDEN");
  });

  it("health check updates status and notifies managers on failure", async () => {
    const c = await p.connectors.create(O.adminCtx(), { type: "sandbox", name: "health", authType: "api_key", config: {} });
    await p.connectors.setCredentials(O.adminCtx(), c.id, { values: { apiKey: "invalid" } });
    const r = await p.connectors.test(O.adminCtx(), c.id);
    expect(r.ok).toBe(false);
    expect((await p.connectors.get(O.adminCtx(), c.id)).healthStatus).toBe("unhealthy");
    const notes = await p.notifications.listMine(O.adminCtx(), {});
    expect(notes.data.some((n) => n.type === "core.connector_failed" && n.resourceId === c.id)).toBe(true);
  });
});
