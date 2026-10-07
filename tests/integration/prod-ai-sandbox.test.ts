import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrg, createTestPlatform, expectCode } from "../helpers/platform";

/**
 * The simulated "sandbox" AI provider must never be usable in production: it is
 * not seeded (syncCatalog skips development-only providers), not listed, and not
 * routable. In development it is available so the platform works without a real
 * key. Verified on two platforms configured identically except for APP_ENV.
 */
const PROD_ENV = { APP_ENV: "production", APP_URL: "https://app.example", ALLOW_LOCAL_SECRETS_IN_PRODUCTION: "true" };
const ask = (useCase: string) => ({ moduleId: "core", useCase, messages: [{ role: "user" as const, content: "hello" }] });

let prod: Awaited<ReturnType<typeof createTestPlatform>>;
let dev: Awaited<ReturnType<typeof createTestPlatform>>;
let prodOrg: Awaited<ReturnType<typeof createOrg>>;
let devOrg: Awaited<ReturnType<typeof createOrg>>;

beforeAll(async () => {
  prod = await createTestPlatform({}, PROD_ENV);
  dev = await createTestPlatform(); // APP_ENV=test
  prodOrg = await createOrg(prod);
  devOrg = await createOrg(dev);
});
afterAll(async () => {
  await prod.close();
  await dev.close();
});

describe("Sandbox AI provider is hidden in production", () => {
  it("development: the sandbox provider is present and routable", async () => {
    const providers = await dev.ai.listProviders(devOrg.adminCtx());
    expect(providers.some((p) => p.kind === "sandbox")).toBe(true);
    const r = await dev.ai.execute(devOrg.adminCtx(), ask("test.generate"));
    expect(r.provider).toBe("sandbox");
  });

  it("production: the sandbox provider is not listed", async () => {
    const providers = await prod.ai.listProviders(prodOrg.adminCtx());
    expect(providers.some((p) => p.kind === "sandbox")).toBe(false);
    expect(providers.some((p) => p.key === "sandbox")).toBe(false);
  });

  it("production: with no real provider configured, AI requests fail closed rather than falling back to the simulator", async () => {
    await expectCode(prod.ai.execute(prodOrg.adminCtx(), ask("test.generate")), "NOT_CONFIGURED");
  });
});
