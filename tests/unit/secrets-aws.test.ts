import { beforeEach, describe, expect, it } from "vitest";
import { AwsSecretsManagerStore, type AwsSecretsClient } from "../../packages/secrets/src/aws";
import { parseSecretRef } from "../../packages/secrets/src";

/**
 * AWS Secrets Manager adapter (the store production will use). Exercised against
 * an in-memory double of the AWS client — this sandbox has no AWS credentials or
 * network, so run one live smoke test in staging before relying on it.
 */
class FakeAws implements AwsSecretsClient {
  store = new Map<string, string>();
  reads = 0;
  async create(name: string, value: string) {
    if (this.store.has(name)) throw Object.assign(new Error("exists"), { name: "ResourceExistsException" });
    this.store.set(name, value);
  }
  async read(name: string) {
    this.reads++;
    return this.store.has(name) ? this.store.get(name)! : null;
  }
  async update(name: string, value: string) {
    this.store.set(name, value);
  }
  async remove(name: string) {
    this.store.delete(name);
  }
}

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

let aws: FakeAws;
let store: AwsSecretsManagerStore;

beforeEach(() => {
  aws = new FakeAws();
  store = new AwsSecretsManagerStore(async () => aws, { prefix: "eaop-test/" });
});

describe("AwsSecretsManagerStore", () => {
  it("stores a value and returns a well-formed aws reference bound to the owner", async () => {
    const ref = await store.put({ organizationId: ORG_A, name: "connector:x", value: "s3cr3t" });
    const parsed = parseSecretRef(ref);
    expect(parsed).toMatchObject({ provider: "aws", owner: ORG_A, version: 1 });
    // The DB only ever sees the reference; the value lives in AWS under <prefix><owner>/<id>.
    expect([...aws.store.keys()][0]).toBe(`eaop-test/${ORG_A}/${parsed.id}`);
    expect([...aws.store.values()][0]).toBe("s3cr3t");
    expect(await store.get(ref, ORG_A)).toBe("s3cr3t");
  });

  it("platform-owned secrets use the 'platform' owner segment", async () => {
    const ref = await store.put({ organizationId: null, name: "oidc", value: "p" });
    expect(parseSecretRef(ref).owner).toBe("platform");
    expect(await store.get(ref, null)).toBe("p");
  });

  it("refuses to resolve a reference for a different tenant (no cross-tenant read)", async () => {
    const ref = await store.put({ organizationId: ORG_A, name: "k", value: "A-only" });
    await expect(store.get(ref, ORG_B)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(store.get(ref, null)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(store.rotate(ref, ORG_B, "x")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(store.destroy(ref, ORG_B)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rotate stores a new value, bumps the reference version, and get returns the latest", async () => {
    const v1 = await store.put({ organizationId: ORG_A, name: "k", value: "old" });
    const v2 = await store.rotate(v1, ORG_A, "new");
    expect(parseSecretRef(v2).version).toBe(2);
    expect(parseSecretRef(v2).id).toBe(parseSecretRef(v1).id);
    expect(await store.get(v2, ORG_A)).toBe("new");
    expect(await store.get(v1, ORG_A)).toBe("new"); // same underlying secret (AWSCURRENT)
  });

  it("destroy removes the secret; subsequent reads fail NOT_FOUND", async () => {
    const ref = await store.put({ organizationId: ORG_A, name: "k", value: "v" });
    await store.destroy(ref, ORG_A);
    await expect(store.get(ref, ORG_A)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a reference from a different provider (e.g. a leftover local ref)", async () => {
    const localRef = `secret://local/${ORG_A}/${crypto.randomUUID()}#v1`;
    await expect(store.get(localRef, ORG_A)).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });

  it("a missing secret reads as NOT_FOUND, not a crash", async () => {
    const ref = `secret://aws/${ORG_A}/${crypto.randomUUID()}#v1`;
    await expect(store.get(ref, ORG_A)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
