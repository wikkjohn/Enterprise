import { randomUUID } from "node:crypto";
import { AppError, notConfigured, type Uuid } from "@eaop/shared-types";
import { parseSecretRef, type SecretStore } from "./index";

/**
 * Minimal, injectable AWS Secrets Manager surface. The production
 * implementation (createAwsSecretsClient) wraps @aws-sdk/client-secrets-manager;
 * tests inject an in-memory double. `read` resolves null when the secret does
 * not exist or is pending deletion.
 */
export interface AwsSecretsClient {
  create(name: string, value: string): Promise<void>;
  read(name: string): Promise<string | null>;
  update(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
}

function ownerOf(organizationId: Uuid | null) {
  return organizationId ?? "platform";
}

/**
 * AWS Secrets Manager-backed {@link SecretStore}. The application DB still holds
 * only `secret://aws/<owner>/<id>#v<n>` references; the value lives in AWS under
 * the name `<prefix><owner>/<id>`. The owner segment is embedded in the name and
 * re-checked on every access, so a tenant can never resolve another tenant's (or
 * the platform's) secret even if it guesses a reference.
 *
 * On rotate, AWS moves the AWSCURRENT staging label to the new version (AWSPREVIOUS
 * is retained per AWS's own model); `get` always reads AWSCURRENT, so callers see
 * the latest value. The returned reference's version integer is advisory.
 */
export class AwsSecretsManagerStore implements SecretStore {
  readonly provider = "aws" as const;
  private readonly prefix: string;

  constructor(private readonly clientProvider: () => Promise<AwsSecretsClient>, opts: { prefix?: string } = {}) {
    this.prefix = opts.prefix ?? "eaop/";
  }

  private name(owner: string, id: string) {
    return `${this.prefix}${owner}/${id}`;
  }

  private assertOwner(ref: ReturnType<typeof parseSecretRef>, organizationId: Uuid | null) {
    if (ref.provider !== "aws") throw notConfigured(`Secret provider "${ref.provider}"`);
    if (ref.owner !== ownerOf(organizationId)) throw new AppError("FORBIDDEN", "Secret reference does not belong to this organization.");
  }

  async put({ organizationId, value }: { organizationId: Uuid | null; name: string; value: string }) {
    const owner = ownerOf(organizationId);
    const id = randomUUID();
    const client = await this.clientProvider();
    await client.create(this.name(owner, id), value);
    return `secret://aws/${owner}/${id}#v1`;
  }

  async get(ref: string, organizationId: Uuid | null) {
    const parsed = parseSecretRef(ref);
    this.assertOwner(parsed, organizationId);
    const client = await this.clientProvider();
    const value = await client.read(this.name(parsed.owner, parsed.id));
    if (value === null) throw new AppError("NOT_FOUND", "Secret not found or destroyed.");
    return value;
  }

  async rotate(ref: string, organizationId: Uuid | null, value: string) {
    const parsed = parseSecretRef(ref);
    this.assertOwner(parsed, organizationId);
    const client = await this.clientProvider();
    await client.update(this.name(parsed.owner, parsed.id), value);
    return `secret://aws/${parsed.owner}/${parsed.id}#v${parsed.version + 1}`;
  }

  async destroy(ref: string, organizationId: Uuid | null) {
    const parsed = parseSecretRef(ref);
    this.assertOwner(parsed, organizationId);
    const client = await this.clientProvider();
    await client.remove(this.name(parsed.owner, parsed.id));
  }
}

/**
 * Lazily constructs a real AWS Secrets Manager client on first use, so the AWS
 * SDK is only loaded when SECRETS_PROVIDER=aws. Region and credentials come from
 * the standard AWS environment / instance role (no bootstrap secret to manage).
 */
export function createAwsSecretsClient(opts: { region?: string } = {}): () => Promise<AwsSecretsClient> {
  let cached: AwsSecretsClient | undefined;
  return async () => {
    if (cached) return cached;
    const sdk = await import("@aws-sdk/client-secrets-manager");
    const client = new sdk.SecretsManagerClient(opts.region ? { region: opts.region } : {});
    cached = {
      async create(name, value) {
        await client.send(new sdk.CreateSecretCommand({ Name: name, SecretString: value }));
      },
      async read(name) {
        try {
          const r = await client.send(new sdk.GetSecretValueCommand({ SecretId: name }));
          return r.SecretString ?? null;
        } catch (e) {
          const code = (e as { name?: string }).name;
          if (code === "ResourceNotFoundException" || code === "InvalidRequestException") return null; // missing or pending deletion
          throw e;
        }
      },
      async update(name, value) {
        await client.send(new sdk.PutSecretValueCommand({ SecretId: name, SecretString: value }));
      },
      async remove(name) {
        try {
          await client.send(new sdk.DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true }));
        } catch (e) {
          if ((e as { name?: string }).name === "ResourceNotFoundException") return;
          throw e;
        }
      },
    };
    return cached;
  };
}
