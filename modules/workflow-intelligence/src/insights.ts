import { sql } from "@eaop/db";
import { type InsightProvider, type Platform } from "@eaop/platform";
import { MODULE_ID } from "./service";

const BASE = "/m/workflow-intelligence";
const n = (v: unknown) => Number(v ?? 0) || 0;

/** Aggregate value pipeline for cross-module analytics (AI Operations). No workflow names or content. */
export function workflowInsights(platform: Pick<Platform, "db">): InsightProvider {
  return {
    moduleId: MODULE_ID,
    label: "Workflow Intelligence",
    async collect(ctx) {
      const r = await platform.db.withTenant({ organizationId: ctx.organizationId }, (tx) => tx.execute(sql`
        select
          (select count(*) from wi_workflows where organization_id = ${ctx.organizationId} and status <> 'retired') as workflows,
          (select count(*) from wi_workflow_opportunities where organization_id = ${ctx.organizationId} and status in ('identified','approved','in_implementation')) as open_opportunities,
          (select coalesce(sum(estimated_annual_savings), 0) from wi_workflow_opportunities where organization_id = ${ctx.organizationId} and status in ('approved','in_implementation','delivered')) as projected,
          (select count(*) from wi_workflow_implementations where organization_id = ${ctx.organizationId} and stage in ('production','measured')) as in_production,
          (select coalesce(sum(v), 0) from (
            select distinct on (implementation_id) (select (l->>'actual')::numeric from jsonb_array_elements(outputs->'lines') l where l->>'key' = 'annualSavings') as v
            from wi_workflow_roi_calculations where organization_id = ${ctx.organizationId} and kind = 'actual' and implementation_id is not null
            order by implementation_id, created_at desc) x) as realized`));
      const row = (r.rows[0] ?? {}) as Record<string, unknown>;
      return [
        { key: "workflows.total", label: "Workflows in inventory", value: n(row.workflows), unit: "count", basis: "measured", href: `${BASE}/workflows` },
        { key: "opportunities.open", label: "Open AI opportunities", value: n(row.open_opportunities), unit: "count", basis: "measured", href: `${BASE}/opportunities` },
        { key: "value.projected_annual_usd", label: "Projected annual savings (approved opportunities)", value: n(row.projected), unit: "usd_per_year", basis: "estimated", href: `${BASE}/opportunities` },
        { key: "implementations.production", label: "Implementations in production", value: n(row.in_production), unit: "count", basis: "measured", href: `${BASE}/implementations` },
        { key: "value.realized_annual_usd", label: "Realized annual savings (latest measurements)", value: n(row.realized), unit: "usd_per_year", basis: "measured", href: `${BASE}/implementations` },
      ];
    },
  };
}
