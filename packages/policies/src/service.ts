import { z } from "zod";
import { and, desc, eq, policies, policyVersions, scopeOf, type Database } from "@eaop/db";
import { AuditActions, type AuditService } from "@eaop/audit";
import { type EventBus } from "@eaop/events";
import { type Authorizer } from "@eaop/rbac";
import { AppError, conflict, notFound, type TenantContext } from "@eaop/shared-types";
import { type PolicyDecision, type PolicyDefinition, type PolicyEngine, type PolicyInput, type PolicyKind } from "./engine";

export const createPolicySchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_.-]{2,80}$/),
  name: z.string().min(1).max(160),
  description: z.string().max(2000).default(""),
  kind: z.string().min(1).max(64),
  definition: z.unknown(),
  changeNote: z.string().max(500).optional(),
});

export interface PolicyView {
  id: string;
  key: string;
  name: string;
  description: string;
  owner: string;
  kind: string;
  status: string;
  activeVersion: number | null;
  latestVersion: number;
  updatedAt: string;
}

export interface PolicyVersionView {
  version: number;
  definition: PolicyDefinition;
  changeNote: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface PolicyService {
  registerKind(kind: PolicyKind): void;
  kinds(): PolicyKind[];
  list(ctx: TenantContext): Promise<PolicyView[]>;
  get(ctx: TenantContext, key: string): Promise<PolicyView & { versions: PolicyVersionView[] }>;
  create(ctx: TenantContext, input: z.input<typeof createPolicySchema>): Promise<PolicyView>;
  /** Creates a new immutable version (does not activate it). */
  addVersion(ctx: TenantContext, key: string, definition: unknown, changeNote?: string): Promise<PolicyVersionView>;
  activate(ctx: TenantContext, key: string, version: number): Promise<PolicyView>;
  disable(ctx: TenantContext, key: string): Promise<PolicyView>;
  /** Dry-run a definition or stored version against an input (policy.read). */
  simulate(ctx: TenantContext, input: { key?: string; version?: number; definition?: unknown; request: PolicyInput }): Promise<PolicyDecision>;
  /**
   * Evaluate the ACTIVE version of every active policy of `kind` and combine
   * them deny-overrides. Internal API for modules (no permission check — the
   * caller is enforcing policy on its own operation). Returns ALLOW with
   * `defaulted` when no active policy exists unless `defaultEffect` is given.
   */
  evaluateKind(ctx: TenantContext, kind: string, request: PolicyInput, opts?: { defaultEffect?: PolicyDecision["effect"] }): Promise<PolicyDecision & { policies: Array<{ key: string; version: number; effect: string }> }>;
}

export function createPolicyService(deps: { db: Database; engine: PolicyEngine; authorizer: Authorizer; audit: AuditService; bus: EventBus }): PolicyService {
  const { db, engine, authorizer, audit, bus } = deps;
  const kinds = new Map<string, PolicyKind>();
  kinds.set("access", {
    key: "access",
    owner: "core",
    description: "Generic attribute-based access rules evaluated by the shared core.",
    attributes: { "subject.roles": "role keys", "resource.type": "resource type", "context.environment": "organization environment" },
  });

  const view = (p: typeof policies.$inferSelect, latest: number): PolicyView => ({
    id: p.id,
    key: p.key,
    name: p.name,
    description: p.description,
    owner: p.owner,
    kind: p.kind,
    status: p.status,
    activeVersion: p.activeVersion,
    latestVersion: latest,
    updatedAt: p.updatedAt.toISOString(),
  });

  function validate(definition: unknown): PolicyDefinition {
    try {
      return engine.validate(definition);
    } catch (err) {
      throw new AppError("VALIDATION_FAILED", "Invalid policy definition.", { reason: err instanceof Error ? err.message.slice(0, 500) : String(err) });
    }
  }

  async function load(ctx: TenantContext, key: string) {
    return db.withTenant(scopeOf(ctx), async (tx) => {
      const [p] = await tx.select().from(policies).where(and(eq(policies.organizationId, ctx.organizationId), eq(policies.key, key))).limit(1);
      if (!p) throw notFound("Policy", key);
      const versions = await tx.select().from(policyVersions).where(eq(policyVersions.policyId, p.id)).orderBy(desc(policyVersions.version));
      return { p, versions };
    });
  }

  const versionView = (v: typeof policyVersions.$inferSelect): PolicyVersionView => ({
    version: v.version,
    definition: v.definition as unknown as PolicyDefinition,
    changeNote: v.changeNote,
    createdBy: v.createdBy,
    createdAt: v.createdAt.toISOString(),
  });

  return {
    registerKind(kind) {
      const existing = kinds.get(kind.key);
      if (existing && existing.owner !== kind.owner) throw new Error(`Policy kind "${kind.key}" already owned by "${existing.owner}"`);
      kinds.set(kind.key, kind);
    },
    kinds: () => [...kinds.values()],

    async list(ctx) {
      await authorizer.require(ctx, "policy.read");
      return db.withTenant(scopeOf(ctx), async (tx) => {
        const rows = await tx.select().from(policies).where(eq(policies.organizationId, ctx.organizationId)).orderBy(policies.name);
        const versions = await tx.select({ policyId: policyVersions.policyId, version: policyVersions.version }).from(policyVersions).where(eq(policyVersions.organizationId, ctx.organizationId));
        return rows.map((p) => view(p, Math.max(0, ...versions.filter((v) => v.policyId === p.id).map((v) => v.version))));
      });
    },

    async get(ctx, key) {
      await authorizer.require(ctx, "policy.read");
      const { p, versions } = await load(ctx, key);
      return { ...view(p, versions[0]?.version ?? 0), versions: versions.map(versionView) };
    },

    async create(ctx, raw) {
      await authorizer.require(ctx, "policy.manage");
      const input = createPolicySchema.parse(raw);
      const kind = kinds.get(input.kind);
      if (!kind) throw new AppError("VALIDATION_FAILED", `Unknown policy kind "${input.kind}".`);
      const definition = validate(input.definition ?? kind.template);
      return db.withTenant(scopeOf(ctx), async (tx) => {
        const dup = await tx.select({ id: policies.id }).from(policies).where(and(eq(policies.organizationId, ctx.organizationId), eq(policies.key, input.key))).limit(1);
        if (dup[0]) throw conflict("A policy with that key already exists.");
        const userId = ctx.actor.type === "user" ? ctx.actor.id : null;
        const [p] = await tx
          .insert(policies)
          .values({ organizationId: ctx.organizationId, key: input.key, name: input.name, description: input.description, kind: input.kind, owner: kind.owner, createdBy: userId })
          .returning();
        await tx.insert(policyVersions).values({ organizationId: ctx.organizationId, policyId: p!.id, version: 1, definition: definition as unknown as Record<string, unknown>, changeNote: input.changeNote ?? "Initial version", createdBy: userId });
        await audit.record(ctx, { action: AuditActions.POLICY_CREATED, resourceType: "policy", resourceId: p!.id, after: { key: input.key, kind: input.kind, definition } });
        return view(p!, 1);
      });
    },

    async addVersion(ctx, key, definition, changeNote) {
      await authorizer.require(ctx, "policy.manage");
      const def = validate(definition);
      const { p, versions } = await load(ctx, key);
      const next = (versions[0]?.version ?? 0) + 1;
      return db.withTenant(scopeOf(ctx), async (tx) => {
        const [v] = await tx
          .insert(policyVersions)
          .values({ organizationId: ctx.organizationId, policyId: p.id, version: next, definition: def as unknown as Record<string, unknown>, changeNote: changeNote ?? null, createdBy: ctx.actor.type === "user" ? ctx.actor.id : null })
          .returning();
        await tx.update(policies).set({ updatedAt: new Date() }).where(eq(policies.id, p.id));
        await audit.record(ctx, { action: AuditActions.POLICY_VERSIONED, resourceType: "policy", resourceId: p.id, before: versions[0] ? { version: versions[0].version, definition: versions[0].definition } : undefined, after: { version: next, definition: def }, metadata: { changeNote } });
        return versionView(v!);
      });
    },

    async activate(ctx, key, version) {
      await authorizer.require(ctx, "policy.manage");
      const { p, versions } = await load(ctx, key);
      if (!versions.some((v) => v.version === version)) throw notFound("Policy version", String(version));
      return db.withTenant(scopeOf(ctx), async (tx) => {
        const [u] = await tx.update(policies).set({ status: "active", activeVersion: version, updatedAt: new Date() }).where(eq(policies.id, p.id)).returning();
        await audit.record(ctx, { action: AuditActions.POLICY_ACTIVATED, resourceType: "policy", resourceId: p.id, before: { status: p.status, activeVersion: p.activeVersion }, after: { status: "active", activeVersion: version } });
        await bus.publish(ctx, "policy.activated", { policyId: p.id, key: p.key, version });
        return view(u!, versions[0]!.version);
      });
    },

    async disable(ctx, key) {
      await authorizer.require(ctx, "policy.manage");
      const { p, versions } = await load(ctx, key);
      return db.withTenant(scopeOf(ctx), async (tx) => {
        const [u] = await tx.update(policies).set({ status: "disabled", updatedAt: new Date() }).where(eq(policies.id, p.id)).returning();
        await audit.record(ctx, { action: AuditActions.POLICY_DISABLED, resourceType: "policy", resourceId: p.id, before: { status: p.status }, after: { status: "disabled" } });
        return view(u!, versions[0]?.version ?? 0);
      });
    },

    async simulate(ctx, input) {
      await authorizer.require(ctx, "policy.read");
      let def: PolicyDefinition;
      if (input.definition !== undefined) def = validate(input.definition);
      else if (input.key) {
        const { p, versions } = await load(ctx, input.key);
        const v = versions.find((x) => x.version === (input.version ?? p.activeVersion ?? versions[0]?.version));
        if (!v) throw notFound("Policy version");
        def = v.definition as unknown as PolicyDefinition;
      } else throw new AppError("VALIDATION_FAILED", "Provide a policy key or a definition.");
      return engine.evaluate(def, input.request);
    },

    async evaluateKind(ctx, kind, request, opts = {}) {
      const rows = await db.withTenant(scopeOf(ctx), (tx) =>
        tx
          .select({ key: policies.key, version: policyVersions.version, definition: policyVersions.definition })
          .from(policies)
          .innerJoin(policyVersions, and(eq(policyVersions.policyId, policies.id), eq(policyVersions.version, policies.activeVersion)))
          .where(and(eq(policies.organizationId, ctx.organizationId), eq(policies.kind, kind), eq(policies.status, "active"))),
      );
      if (rows.length === 0) {
        const effect = opts.defaultEffect ?? "ALLOW";
        return { effect, matchedRules: [], defaulted: true, reasons: [`no active "${kind}" policy → ${effect}`], policies: [] };
      }
      const results = rows.map((r) => ({ key: r.key, version: r.version, decision: engine.evaluate(r.definition as unknown as PolicyDefinition, request) }));
      const order = { ALLOW: 0, REQUIRE_APPROVAL: 1, ESCALATE: 2, DENY: 3 } as const;
      const worst = results.reduce((a, b) => (order[b.decision.effect] > order[a.decision.effect] ? b : a));
      return {
        effect: worst.decision.effect,
        matchedRules: results.flatMap((r) => r.decision.matchedRules.map((m) => ({ ...m, id: `${r.key}#${m.id}` }))),
        defaulted: results.every((r) => r.decision.defaulted),
        reasons: results.flatMap((r) => r.decision.reasons.map((x) => `[${r.key} v${r.version}] ${x}`)),
        policies: results.map((r) => ({ key: r.key, version: r.version, effect: r.decision.effect })),
      };
    },
  };
}
