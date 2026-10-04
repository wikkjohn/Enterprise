import { type Logger } from "@eaop/observability";
import { type Authorizer } from "@eaop/rbac";
import { type OwnerId, type TenantContext } from "@eaop/shared-types";

export interface SearchHit {
  resourceType: string;
  id: string;
  title: string;
  subtitle?: string;
  /** In-app relative URL. */
  url: string;
  /** 0..1 relevance; providers should normalise. */
  score: number;
}

/**
 * A searchable resource type registered by the core or a module.
 * The platform checks `permission` (and the owning module's entitlement)
 * before invoking `search`. Providers MUST additionally apply any
 * per-resource restrictions themselves and query only through tenant-scoped
 * DB access, so results never include rows from another organization.
 */
export interface SearchProvider {
  resourceType: string;
  owner: OwnerId;
  label: string;
  permission: string;
  search(ctx: TenantContext, query: string, limit: number): Promise<SearchHit[]>;
}

export interface SearchService {
  register(provider: SearchProvider): void;
  providers(): Array<Pick<SearchProvider, "resourceType" | "owner" | "label" | "permission">>;
  query(ctx: TenantContext, q: string, opts?: { types?: string[]; limit?: number }): Promise<{ hits: SearchHit[]; searchedTypes: string[] }>;
}

const PROVIDER_TIMEOUT_MS = 2_000;

export function createSearchService(deps: { authorizer: Authorizer; logger: Logger }): SearchService {
  const providers = new Map<string, SearchProvider>();

  return {
    register(p) {
      if (providers.has(p.resourceType)) throw new Error(`Search provider for "${p.resourceType}" already registered`);
      providers.set(p.resourceType, p);
    },
    providers: () => [...providers.values()].map(({ resourceType, owner, label, permission }) => ({ resourceType, owner, label, permission })),
    async query(ctx, raw, opts = {}) {
      const q = raw.trim().slice(0, 200);
      if (q.length < 2) return { hits: [], searchedTypes: [] };
      await deps.authorizer.require(ctx, "search.use");
      const limit = Math.min(opts.limit ?? 20, 50);
      const candidates = [...providers.values()].filter((p) => !opts.types || opts.types.includes(p.resourceType));
      const allowed: SearchProvider[] = [];
      for (const p of candidates) if (await deps.authorizer.can(ctx, p.permission)) allowed.push(p);

      const results = await Promise.all(
        allowed.map(async (p) => {
          let timer: NodeJS.Timeout | undefined;
          try {
            return await Promise.race([
              p.search(ctx, q, limit),
              new Promise<SearchHit[]>((resolve) => {
                timer = setTimeout(() => resolve([]), PROVIDER_TIMEOUT_MS);
              }),
            ]);
          } catch (err) {
            deps.logger.warn("search.provider_failed", { resourceType: p.resourceType, error: (err as Error).message });
            return [];
          } finally {
            clearTimeout(timer);
          }
        }),
      );
      const hits = results
        .flat()
        .filter((h) => h.url.startsWith("/") && !h.url.startsWith("//"))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      return { hits, searchedTypes: allowed.map((p) => p.resourceType) };
    },
  };
}

/** Simple relevance: exact > prefix > substring, case-insensitive. */
export function textScore(query: string, ...fields: Array<string | null | undefined>): number {
  const q = query.toLowerCase();
  let best = 0;
  for (const f of fields) {
    if (!f) continue;
    const v = f.toLowerCase();
    if (v === q) best = Math.max(best, 1);
    else if (v.startsWith(q)) best = Math.max(best, 0.8);
    else if (v.includes(q)) best = Math.max(best, 0.5);
  }
  return best;
}
