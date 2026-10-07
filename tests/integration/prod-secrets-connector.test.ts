import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectorCredentialsMetadata, eq, sql } from "../../packages/db/src";
import { AwsSecretsManagerStore, type AwsSecretsClient } from "../../packages/secrets/src/aws";
import { createOrg, createTestPlatform } from "../helpers/platform";

/**
 * Real connector credentials on the production secret backend. The platform is
 * built with the AWS Secrets Manager store (over an in-memory AWS double), and a
 * connector's API key is stored and resolved through it — proving the DB holds
 * only a reference and the secret value never lands in a tenant table.
 */
class FakeAws implements AwsSecretsClient {
  store = new Map<string, string>();
  async create(n: string, v: string) {
    this.store.set(n, v);
  }
  async read(n: string) {
    return this.store.get(n) ?? null;
  }
  async update(n: string, v: string) {
    this.store.set(n, v);
  }
  async remove(n: string) {
    this.store.delete(n);
  }
}

const API_KEY = "tok_live_SECRET_9f2a7c";
let aws: FakeAws;
let p: Awaited<ReturnType<typeof createTestPlatform>>;
let O: Awaited<ReturnType<typeof createOrg>>;
let B: Awaited<ReturnType<typeof createOrg>>;

beforeAll(async () => {
  aws = new FakeAws();
  p = await createTestPlatform({ secrets: new AwsSecretsManagerStore(async () => aws, { prefix: "eaop/" }) });
  O = await createOrg(p);
  B = await createOrg(p);
});
afterAll(() => p.close());

describe("Connector credentials on the AWS secret store", () => {
  it("stores the API key in AWS and keeps only a reference in the database", async () => {
    const c = await p.connectors.create(O.adminCtx(), { type: "rest_api", name: "Billing API", authType: "api_key", config: { baseUrl: "https://api.billing.example" } });
    await p.connectors.setCredentials(O.adminCtx(), c.id, { values: { apiKey: API_KEY } });

    // The secret value is in AWS, JSON-encoded, under an org-scoped name.
    const stored = [...aws.store.entries()];
    expect(stored).toHaveLength(1);
    expect(stored[0]![0]).toMatch(new RegExp(`^eaop/${O.org.id}/`));
    expect(JSON.parse(stored[0]![1]).apiKey).toBe(API_KEY);

    // The DB credential row holds an aws reference, not the key.
    const [row] = await p.db.withSystem("test", (tx) =>
      tx.select().from(connectorCredentialsMetadata).where(eq(connectorCredentialsMetadata.connectorId, c.id)),
    );
    expect(row!.secretRef).toMatch(/^secret:\/\/aws\//);

    // The raw key is nowhere in the tenant's connector tables.
    const dump = JSON.stringify(
      await p.db.withSystem("test", async (tx) => ({
        connectors: await tx.execute(sql`select * from connectors`),
        creds: await tx.execute(sql`select * from connector_credentials_metadata`),
      })),
    );
    expect(dump).not.toContain(API_KEY);
  });

  it("resolves the credential only for the owning tenant", async () => {
    // Scope to this org — the shared integration DB holds other files' credential rows too.
    const [row] = await p.db.withSystem("test", (tx) => tx.select().from(connectorCredentialsMetadata).where(eq(connectorCredentialsMetadata.organizationId, O.org.id)));
    expect(await p.secrets.get(row!.secretRef, O.org.id)).toContain(API_KEY);
    await expect(p.secrets.get(row!.secretRef, B.org.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rotating the credential replaces the value in AWS and bumps the reference", async () => {
    const c = await p.connectors.create(O.adminCtx(), { type: "rest_api", name: "Orders API", authType: "api_key", config: { baseUrl: "https://api.orders.example" } });
    await p.connectors.setCredentials(O.adminCtx(), c.id, { values: { apiKey: "first_key_aaaa" } });
    await p.connectors.setCredentials(O.adminCtx(), c.id, { values: { apiKey: "second_key_bbbb" } });
    const rows = await p.db.withSystem("test", (tx) => tx.select().from(connectorCredentialsMetadata).where(eq(connectorCredentialsMetadata.connectorId, c.id)));
    const active = rows.find((r) => r.status === "active")!;
    expect(JSON.parse(await p.secrets.get(active.secretRef, O.org.id)).apiKey).toBe("second_key_bbbb");
  });
});
