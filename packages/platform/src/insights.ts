import { type ModuleId, type TenantContext } from "@eaop/shared-types";

/**
 * Cross-module analytics read models.
 *
 * Each installed module may register ONE provider that summarises its own
 * domain as a handful of aggregate numbers (counts, money, percentages). Other
 * modules — chiefly AI Operations Management — read these summaries instead of
 * querying another module's tables. Providers must return aggregates only
 * (never names, content or per-person data) and must stay cheap: they run on
 * dashboard loads.
 */
export interface InsightMetric {
  /** Stable key, e.g. "value.projected_annual_usd". */
  key: string;
  label: string;
  value: number;
  unit: "count" | "usd" | "usd_per_year" | "percent";
  /** measured = recorded facts; estimated = projections or model outputs. */
  basis: "measured" | "estimated";
  /** Drill-down link inside the owning module. */
  href?: string;
}

export interface InsightProvider {
  moduleId: ModuleId;
  label: string;
  collect(ctx: TenantContext): Promise<InsightMetric[]>;
}

export interface ModuleInsights {
  moduleId: ModuleId;
  label: string;
  metrics: InsightMetric[];
  /** Set when the provider failed; the other modules' insights are still returned. */
  error?: string;
}

export interface InsightRegistry {
  register(provider: InsightProvider): void;
  /** Summaries from every provider whose module is enabled for the tenant. */
  collect(ctx: TenantContext): Promise<ModuleInsights[]>;
}

export function createInsightRegistry(deps: { isEnabled(orgId: string, moduleId: string): Promise<boolean>; onError(moduleId: string, err: unknown): void }): InsightRegistry {
  const providers = new Map<string, InsightProvider>();
  return {
    register(p) {
      if (providers.has(p.moduleId)) throw new Error(`Insight provider for "${p.moduleId}" already registered`);
      providers.set(p.moduleId, p);
    },
    async collect(ctx) {
      const out: ModuleInsights[] = [];
      for (const p of providers.values()) {
        if (!(await deps.isEnabled(ctx.organizationId, p.moduleId))) continue;
        try {
          out.push({ moduleId: p.moduleId, label: p.label, metrics: await p.collect(ctx) });
        } catch (err) {
          deps.onError(p.moduleId, err);
          out.push({ moduleId: p.moduleId, label: p.label, metrics: [], error: "This module's summary is temporarily unavailable." });
        }
      }
      return out;
    },
  };
}
