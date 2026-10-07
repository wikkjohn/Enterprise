import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { and, devSecretValues, eq, isNull, like, type Database } from "@eaop/db";
import { AppError, notConfigured, type Uuid } from "@eaop/shared-types";
import { AwsSecretsManagerStore, createAwsSecretsClient } from "./aws";

export { AwsSecretsManagerStore, createAwsSecretsClient, type AwsSecretsClient } from "./aws";

/**
 * Provider-agnostic secret storage. The application database stores only
 * secret REFERENCES (plus metadata such as scopes, expiry and rotation).
 *
 * Reference format: secret://<provider>/<org|platform>/<id>#v<version>
 */
export interface SecretStore {
  readonly provider: SecretProviderKind;
  /** Store a new secret; returns its reference. */
  put(input: { organizationId: Uuid | null; name: string; value: string }): Promise<string>;
  /** Resolve a reference. `organizationId` must match the owning tenant (null for platform secrets). */
  get(ref: string, organizationId: Uuid | null): Promise<string>;
  /** Store a new version; the returned reference points at it. Old versions are destroyed. */
  rotate(ref: string, organizationId: Uuid | null, value: string): Promise<string>;
  /** Irreversibly destroy all versions. */
  destroy(ref: string, organizationId: Uuid | null): Promise<void>;
}

export type SecretProviderKind = "local" | "aws" | "azure" | "vault" | "gcp";

export interface ParsedSecretRef {
  provider: SecretProviderKind;
  owner: string;
  id: string;
  version: number;
}

const REF_RE = /^secret:\/\/(local|aws|azure|vault|gcp)\/([a-z0-9-]+)\/([A-Za-z0-9-]+)#v(\d+)$/;

export function parseSecretRef(ref: string): ParsedSecretRef {
  const m = REF_RE.exec(ref);
  if (!m) throw new AppError("VALIDATION_FAILED", "Malformed secret reference.");
  return { provider: m[1] as SecretProviderKind, owner: m[2]!, id: m[3]!, version: Number(m[4]) };
}

function ownerOf(organizationId: Uuid | null) {
  return organizationId ?? "platform";
}

/**
 * LOCAL DEVELOPMENT store: AES-256-GCM ciphertext in `dev_secret_values`,
 * keyed by LOCAL_SECRETS_KEY. Suitable for development, CI and single-node
 * evaluation. In production use a managed secret manager adapter; this store
 * refuses to start in production unless explicitly allowed.
 */
export class LocalEncryptedSecretStore implements SecretStore {
  readonly provider = "local" as const;
  private readonly key: Buffer;

  constructor(private readonly db: Database, keyB64: string, opts: { environment: string; allowInProduction?: boolean }) {
    if (opts.environment === "production" && !opts.allowInProduction) {
      throw new AppError("NOT_CONFIGURED", "The local secret store is disabled in production. Configure SECRETS_PROVIDER.");
    }
    const key = Buffer.from(keyB64, "base64");
    if (key.length !== 32) throw new AppError("NOT_CONFIGURED", "LOCAL_SECRETS_KEY must be 32 bytes, base64-encoded.");
    this.key = key;
  }

  private encrypt(value: string, aad: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), authTag: cipher.getAuthTag().toString("base64") };
  }

  private decrypt(row: { ciphertext: string; iv: string; authTag: string }, aad: string) {
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(row.iv, "base64"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(row.authTag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(row.ciphertext, "base64")), decipher.final()]).toString("utf8");
  }

  async put({ organizationId, value }: { organizationId: Uuid | null; name: string; value: string }) {
    const ref = `secret://local/${ownerOf(organizationId)}/${randomUUID()}#v1`;
    const enc = this.encrypt(value, ref);
    await this.db.withSystem("secrets.put", (tx) => tx.insert(devSecretValues).values({ ref, organizationId, version: 1, ...enc }));
    return ref;
  }

  async get(ref: string, organizationId: Uuid | null) {
    const parsed = parseSecretRef(ref);
    if (parsed.provider !== "local") throw notConfigured(`Secret provider "${parsed.provider}"`);
    // Tenant binding: a tenant can never resolve another tenant's (or the platform's) reference.
    if (parsed.owner !== ownerOf(organizationId)) throw new AppError("FORBIDDEN", "Secret reference does not belong to this organization.");
    const [row] = await this.db.withSystem("secrets.get", (tx) =>
      tx.select().from(devSecretValues).where(and(eq(devSecretValues.ref, ref), isNull(devSecretValues.destroyedAt))).limit(1),
    );
    if (!row) throw new AppError("NOT_FOUND", "Secret not found or destroyed.");
    return this.decrypt(row, ref);
  }

  async rotate(ref: string, organizationId: Uuid | null, value: string) {
    const parsed = parseSecretRef(ref);
    if (parsed.owner !== ownerOf(organizationId)) throw new AppError("FORBIDDEN", "Secret reference does not belong to this organization.");
    const next = `secret://local/${parsed.owner}/${parsed.id}#v${parsed.version + 1}`;
    const enc = this.encrypt(value, next);
    await this.db.withSystem("secrets.rotate", async (tx) => {
      await tx.insert(devSecretValues).values({ ref: next, organizationId, version: parsed.version + 1, ...enc });
      await tx
        .update(devSecretValues)
        .set({ destroyedAt: new Date(), ciphertext: "", iv: "", authTag: "" })
        .where(eq(devSecretValues.ref, ref));
    });
    return next;
  }

  async destroy(ref: string, organizationId: Uuid | null) {
    const parsed = parseSecretRef(ref);
    if (parsed.owner !== ownerOf(organizationId)) throw new AppError("FORBIDDEN", "Secret reference does not belong to this organization.");
    const prefix = `secret://local/${parsed.owner}/${parsed.id}#v%`;
    await this.db.withSystem("secrets.destroy", (tx) =>
      tx
        .update(devSecretValues)
        .set({ destroyedAt: new Date(), ciphertext: "", iv: "", authTag: "" })
        .where(like(devSecretValues.ref, prefix)),
    );
  }
}

/**
 * Placeholder for managed secret managers. Each requires provider SDKs and
 * credentials that are deployment-specific — see docs/CONNECTORS.md
 * ("Secret managers"). They fail closed with NOT_CONFIGURED.
 */
export class UnconfiguredSecretStore implements SecretStore {
  constructor(readonly provider: Exclude<SecretProviderKind, "local">) {}
  private fail(): never {
    throw notConfigured(`Secret manager "${this.provider}"`, {
      hint: "Implement the SecretStore interface for this provider in packages/secrets and set SECRETS_PROVIDER.",
    });
  }
  put(): Promise<string> {
    this.fail();
  }
  get(): Promise<string> {
    this.fail();
  }
  rotate(): Promise<string> {
    this.fail();
  }
  destroy(): Promise<void> {
    this.fail();
  }
}

export function createSecretStore(db: Database, env: { SECRETS_PROVIDER?: string; LOCAL_SECRETS_KEY?: string; APP_ENV?: string; ALLOW_LOCAL_SECRETS_IN_PRODUCTION?: string; AWS_REGION?: string }): SecretStore {
  const provider = (env.SECRETS_PROVIDER ?? "local") as SecretProviderKind;
  if (provider === "local") {
    if (!env.LOCAL_SECRETS_KEY) throw new AppError("NOT_CONFIGURED", "LOCAL_SECRETS_KEY is required for the local secret store.");
    return new LocalEncryptedSecretStore(db, env.LOCAL_SECRETS_KEY, {
      environment: env.APP_ENV ?? "development",
      allowInProduction: env.ALLOW_LOCAL_SECRETS_IN_PRODUCTION === "true",
    });
  }
  if (provider === "aws") return new AwsSecretsManagerStore(createAwsSecretsClient({ region: env.AWS_REGION }));
  if (["azure", "vault", "gcp"].includes(provider)) return new UnconfiguredSecretStore(provider as Exclude<SecretProviderKind, "local">);
  throw new AppError("NOT_CONFIGURED", `Unknown SECRETS_PROVIDER "${provider}".`);
}

/** A display hint for a secret (last 4 characters), safe to store and show. */
export function secretHint(value: string): string {
  return value.length <= 8 ? "••••" : `••••${value.slice(-4)}`;
}
