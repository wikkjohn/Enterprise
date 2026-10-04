import { z } from "zod";
import { and, apiKeysMetadata, desc, eq, organizations, scopeOf, type Database } from "@eaop/db";
import { AuditActions, type AuditService } from "@eaop/audit";
import { type EventBus } from "@eaop/events";
import { type Authorizer, type PermissionRegistry } from "@eaop/rbac";
import { constantTimeEqual, randomToken, sha256 } from "@eaop/security";
import { AppError, forbidden, notFound, type Actor, type TenantContext } from "@eaop/shared-types";

export const createApiKeySchema = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(z.string()).min(1).max(100),
  expiresInDays: z.number().int().min(1).max(730).optional(),
});

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdBy: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

const KEY_RE = /^eaop_([A-Za-z0-9]{12})_([A-Za-z0-9_-]{32,64})$/;
const NON_DELEGABLE = new Set(["platform.admin", "apikey.manage", "role.manage"]);

export interface ApiKeyService {
  /** The raw key is returned ONCE and never stored. */
  create(ctx: TenantContext, input: z.input<typeof createApiKeySchema>): Promise<{ key: string; apiKey: ApiKeyView }>;
  list(ctx: TenantContext): Promise<ApiKeyView[]>;
  revoke(ctx: TenantContext, id: string): Promise<void>;
  authenticate(rawKey: string): Promise<{ organizationId: string; actor: Actor } | null>;
}

export function createApiKeyService(deps: { db: Database; authorizer: Authorizer; registry: PermissionRegistry; audit: AuditService; bus: EventBus }): ApiKeyService {
  const { db, authorizer, registry, audit, bus } = deps;
  const view = (r: typeof apiKeysMetadata.$inferSelect): ApiKeyView => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    scopes: r.scopes,
    createdBy: r.createdBy,
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    revokedAt: r.revokedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  });

  return {
    async create(ctx, raw) {
      await authorizer.require(ctx, "apikey.manage");
      const input = createApiKeySchema.parse(raw);
      const held = await authorizer.effective(ctx);
      for (const s of input.scopes) {
        if (!registry.has(s)) throw new AppError("VALIDATION_FAILED", `Unknown scope "${s}".`);
        if (NON_DELEGABLE.has(s)) throw forbidden(`Scope "${s}" cannot be delegated to an API key.`);
        if (!held.orgWide.has(s)) throw forbidden(`You cannot delegate "${s}" because you do not hold it.`);
      }
      const prefix = randomToken(9).replace(/[^A-Za-z0-9]/g, "").padEnd(12, "0").slice(0, 12);
      const secret = randomToken(32);
      const key = `eaop_${prefix}_${secret}`;
      const [row] = await db.withTenant(scopeOf(ctx), (tx) =>
        tx
          .insert(apiKeysMetadata)
          .values({
            organizationId: ctx.organizationId,
            name: input.name,
            prefix,
            keyHash: sha256(key),
            scopes: [...new Set(input.scopes)].sort(),
            createdBy: ctx.actor.type === "user" ? ctx.actor.id : null,
            expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
          })
          .returning(),
      );
      await audit.record(ctx, { action: AuditActions.API_KEY_CREATED, resourceType: "api_key", resourceId: row!.id, after: { name: input.name, scopes: input.scopes, prefix } });
      await bus.publish(ctx, "api_key.created", { apiKeyId: row!.id, name: input.name, scopes: row!.scopes });
      return { key, apiKey: view(row!) };
    },

    async list(ctx) {
      await authorizer.require(ctx, "apikey.read");
      const rows = await db.withTenant(scopeOf(ctx), (tx) => tx.select().from(apiKeysMetadata).where(eq(apiKeysMetadata.organizationId, ctx.organizationId)).orderBy(desc(apiKeysMetadata.createdAt)));
      return rows.map(view);
    },

    async revoke(ctx, id) {
      await authorizer.require(ctx, "apikey.manage");
      const [row] = await db.withTenant(scopeOf(ctx), (tx) =>
        tx.update(apiKeysMetadata).set({ revokedAt: new Date() }).where(and(eq(apiKeysMetadata.id, id), eq(apiKeysMetadata.organizationId, ctx.organizationId))).returning(),
      );
      if (!row) throw notFound("API key", id);
      await audit.record(ctx, { action: AuditActions.API_KEY_REVOKED, resourceType: "api_key", resourceId: id });
      await bus.publish(ctx, "api_key.revoked", { apiKeyId: id });
    },

    async authenticate(rawKey) {
      const m = KEY_RE.exec(rawKey);
      if (!m) return null;
      const [row] = await db.withSystem("api_keys.authenticate", (tx) =>
        tx
          .select({ k: apiKeysMetadata, orgStatus: organizations.status })
          .from(apiKeysMetadata)
          .innerJoin(organizations, eq(organizations.id, apiKeysMetadata.organizationId))
          .where(eq(apiKeysMetadata.prefix, m[1]!))
          .limit(1),
      );
      if (!row || !constantTimeEqual(row.k.keyHash, sha256(rawKey))) return null;
      if (row.k.revokedAt || (row.k.expiresAt && row.k.expiresAt < new Date()) || row.orgStatus !== "active") return null;
      if (!row.k.lastUsedAt || Date.now() - row.k.lastUsedAt.getTime() > 60_000) {
        await db.withSystem("api_keys.touch", (tx) => tx.update(apiKeysMetadata).set({ lastUsedAt: new Date() }).where(eq(apiKeysMetadata.id, row.k.id)));
      }
      return { organizationId: row.k.organizationId, actor: { type: "api_key", id: row.k.id, label: `api_key:${row.k.name}`, scopes: row.k.scopes } };
    },
  };
}
