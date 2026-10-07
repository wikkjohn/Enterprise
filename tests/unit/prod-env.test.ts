import { describe, expect, it } from "vitest";
import { loadEnv } from "../../packages/platform/src/config";
import { AwsSecretsManagerStore, createSecretStore, LocalEncryptedSecretStore, UnconfiguredSecretStore } from "../../packages/secrets/src";

/**
 * Production environment variables and secret-store selection. Complements
 * tests/unit/security-config.test.ts (egress hardening).
 */
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const prodBase = { APP_ENV: "production", APP_URL: "https://app.example", APP_SECRET: "x".repeat(40), DATABASE_URL: "postgres://x", LOCAL_SECRETS_KEY: KEY };
const db = {} as never; // the local store validates env/key before touching the DB

describe("loadEnv production requirements", () => {
  it("requires an https APP_URL in production", () => {
    expect(() => loadEnv({ ...prodBase, APP_URL: "http://app.example" })).toThrow(/https/);
  });
  it("requires APP_SECRET of at least 32 characters", () => {
    expect(() => loadEnv({ ...prodBase, APP_SECRET: "too-short" })).toThrow(/APP_SECRET/);
  });
  it("accepts a well-formed production configuration", () => {
    const env = loadEnv({ ...prodBase, SECRETS_PROVIDER: "aws", AWS_REGION: "us-east-1" });
    expect(env).toMatchObject({ APP_ENV: "production", SECRETS_PROVIDER: "aws", AWS_REGION: "us-east-1" });
  });
});

describe("createSecretStore selection", () => {
  it("builds the AWS store when SECRETS_PROVIDER=aws", () => {
    const store = createSecretStore(db, { SECRETS_PROVIDER: "aws", APP_ENV: "production", AWS_REGION: "us-east-1" });
    expect(store).toBeInstanceOf(AwsSecretsManagerStore);
    expect(store.provider).toBe("aws");
  });

  it("refuses the local store in production unless explicitly allowed", () => {
    expect(() => createSecretStore(db, { SECRETS_PROVIDER: "local", LOCAL_SECRETS_KEY: KEY, APP_ENV: "production" })).toThrow(/local secret store is disabled in production/i);
    const allowed = createSecretStore(db, { SECRETS_PROVIDER: "local", LOCAL_SECRETS_KEY: KEY, APP_ENV: "production", ALLOW_LOCAL_SECRETS_IN_PRODUCTION: "true" });
    expect(allowed).toBeInstanceOf(LocalEncryptedSecretStore);
  });

  it("the unimplemented managed providers fail closed at use", async () => {
    const vault = createSecretStore(db, { SECRETS_PROVIDER: "vault", APP_ENV: "production" });
    expect(vault).toBeInstanceOf(UnconfiguredSecretStore);
    let caught: unknown;
    try {
      await vault.get("secret://vault/platform/x#v1", null);
    } catch (e) {
      caught = e;
    }
    expect((caught as { code?: string }).code).toBe("NOT_CONFIGURED");
  });
});
