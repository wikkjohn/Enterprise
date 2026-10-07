import { describe, expect, it } from "vitest";
import { loadEnv } from "../../packages/platform/src/config";

/**
 * SECURITY finding #9 (fixed): ALLOW_PRIVATE_NETWORK_EGRESS disables the SSRF guard
 * platform-wide. In production it was only warned about; it is now a hard failure
 * unless explicitly acknowledged with ALLOW_PRIVATE_NETWORK_EGRESS_IN_PRODUCTION.
 */
const base = {
  APP_SECRET: "x".repeat(40),
  DATABASE_URL: "postgres://x",
  LOCAL_SECRETS_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

describe("loadEnv egress hardening", () => {
  it("rejects ALLOW_PRIVATE_NETWORK_EGRESS in production without the explicit acknowledgement", () => {
    expect(() =>
      loadEnv({ ...base, APP_ENV: "production", APP_URL: "https://app.example", ALLOW_PRIVATE_NETWORK_EGRESS: "true" }),
    ).toThrow(/ALLOW_PRIVATE_NETWORK_EGRESS_IN_PRODUCTION/);
  });

  it("allows it in production only with the acknowledgement", () => {
    const env = loadEnv({ ...base, APP_ENV: "production", APP_URL: "https://app.example", ALLOW_PRIVATE_NETWORK_EGRESS: "true", ALLOW_PRIVATE_NETWORK_EGRESS_IN_PRODUCTION: "true" });
    expect(env.ALLOW_PRIVATE_NETWORK_EGRESS).toBe(true);
    expect(env.ALLOW_PRIVATE_NETWORK_EGRESS_IN_PRODUCTION).toBe(true);
  });

  it("is unaffected outside production (dev/on-prem convenience)", () => {
    const env = loadEnv({ ...base, APP_ENV: "development", ALLOW_PRIVATE_NETWORK_EGRESS: "true" });
    expect(env.ALLOW_PRIVATE_NETWORK_EGRESS).toBe(true);
  });

  it("production with the guard on (no egress flag) is fine", () => {
    expect(() => loadEnv({ ...base, APP_ENV: "production", APP_URL: "https://app.example" })).not.toThrow();
  });
});
