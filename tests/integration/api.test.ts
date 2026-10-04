import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createRouteFactory } from "../../packages/api/src";
import { type Platform } from "../../packages/platform/src";
import { CSRF_COOKIE, SESSION_COOKIE } from "../../packages/security/src";
import { addMember, createOrg, createTestPlatform, meta, PASSWORD } from "../helpers/platform";

let p: Platform;
let O: Awaited<ReturnType<typeof createOrg>>;
let route: ReturnType<typeof createRouteFactory>;
let token: string;
const ORIGIN = "http://localhost:3000";

function req(method: string, path: string, opts: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { ...(opts.body ? { "content-type": "application/json" } : {}), ...(opts.cookie ? { cookie: opts.cookie } : {}), ...opts.headers },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}
const cookie = () => `${SESSION_COOKIE}=${token}; ${CSRF_COOKIE}=csrf123`;
const csrf = { origin: ORIGIN, "x-csrf-token": "csrf123" };

beforeAll(async () => {
  p = await createTestPlatform();
  O = await createOrg(p);
  route = createRouteFactory(() => p);
  token = (await p.auth.login({ email: O.admin.email, password: PASSWORD }, meta())).token;
});
afterAll(() => p.close());

const createConnector = () =>
  route({
    auth: "any",
    permission: "connector.manage",
    idempotent: true,
    body: z.object({ name: z.string().min(1) }),
    handler: async ({ ctx, body }) => p.connectors.create(ctx, { type: "sandbox", name: body.name, authType: "none", config: {} }),
  });

describe("API conventions", () => {
  it("401 with the standard envelope when unauthenticated", async () => {
    const res = await createConnector()(req("POST", "/api/v1/connectors", { body: { name: "x" } }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatchObject({ code: "UNAUTHENTICATED" });
    expect(body.error.requestId).toBe(res.headers.get("x-request-id"));
  });

  it("rejects cookie-authenticated mutations without CSRF proof", async () => {
    const r1 = await createConnector()(req("POST", "/api/v1/connectors", { body: { name: "x" }, cookie: cookie() }));
    expect(r1.status).toBe(403);
    expect((await r1.json()).error.code).toBe("CSRF_FAILED");
    const r2 = await createConnector()(req("POST", "/api/v1/connectors", { body: { name: "x" }, cookie: cookie(), headers: { origin: "https://evil.example", "x-csrf-token": "csrf123" } }));
    expect(r2.status).toBe(403);
  });

  it("201 on success; 422 with field issues on invalid input", async () => {
    const ok = await createConnector()(req("POST", "/api/v1/connectors", { body: { name: "via-api" }, cookie: cookie(), headers: csrf }));
    expect(ok.status).toBe(201);
    expect((await ok.json()).data.name).toBe("via-api");
    const bad = await createConnector()(req("POST", "/api/v1/connectors", { body: { name: "" }, cookie: cookie(), headers: csrf }));
    expect(bad.status).toBe(422);
    expect((await bad.json()).error.details.issues[0].path).toBe("name");
  });

  it("403 for insufficient permissions (server-side, regardless of UI)", async () => {
    const viewer = await addMember(p, O.org.id, ["read_only"]);
    const vt = (await p.auth.login({ email: viewer.user.email, password: PASSWORD }, meta())).token;
    const res = await createConnector()(req("POST", "/api/v1/connectors", { body: { name: "x" }, cookie: `${SESSION_COOKIE}=${vt}; ${CSRF_COOKIE}=csrf123`, headers: csrf }));
    expect(res.status).toBe(403);
  });

  it("API keys authenticate with Bearer and need no CSRF; scopes still apply", async () => {
    const { key } = await p.apiKeys.create(O.adminCtx(), { name: "ci", scopes: ["connector.manage", "connector.read"] });
    const res = await createConnector()(req("POST", "/api/v1/connectors", { body: { name: "via-key" }, headers: { authorization: `Bearer ${key}` } }));
    expect(res.status).toBe(201);
    const bad = await createConnector()(req("POST", "/api/v1/connectors", { body: { name: "x" }, headers: { authorization: "Bearer eaop_AAAAAAAAAAAA_notarealkeynotarealkeynotarealkey00" } }));
    expect(bad.status).toBe(401);
  });

  it("Idempotency-Key replays the original response and rejects reuse with a different body", async () => {
    const h = { ...csrf, "idempotency-key": "idem-key-0001" };
    const r1 = await createConnector()(req("POST", "/api/v1/connectors", { body: { name: "idem" }, cookie: cookie(), headers: h }));
    const r2 = await createConnector()(req("POST", "/api/v1/connectors", { body: { name: "idem" }, cookie: cookie(), headers: h }));
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.headers.get("idempotent-replayed")).toBe("true");
    expect((await r2.json()).data.id).toBe((await r1.json()).data.id);
    const r3 = await createConnector()(req("POST", "/api/v1/connectors", { body: { name: "different" }, cookie: cookie(), headers: h }));
    expect(r3.status).toBe(409);
  });

  it("never leaks internal errors or stack traces", async () => {
    const boom = route({ auth: "public", handler: async () => { throw new Error("db password=hunter2 at /srv/app.ts:12"); } });
    const res = await boom(req("GET", "/api/v1/boom"));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("app.ts");
    expect(JSON.parse(text).error.code).toBe("INTERNAL");
  });

  it("module-gated routes return MODULE_NOT_ENABLED", async () => {
    const r = route({ auth: "session", module: "workflow_intelligence", handler: async () => ({ ok: true }) });
    const res = await r(req("GET", "/api/v1/m/workflow", { cookie: cookie() }));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("MODULE_NOT_ENABLED");
  });

  it("rate limits public endpoints per IP", async () => {
    const r = route({ auth: "public", rateLimit: { limit: 2, windowSeconds: 60 }, handler: async () => ({ ok: true }) });
    const call = () => r(req("GET", "/api/v1/ping", { headers: { "x-forwarded-for": "198.51.100.7" } }));
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    const limited = await call();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });
});
