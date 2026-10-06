import { sql } from "@eaop/db";
import { type InsightProvider, type Platform } from "@eaop/platform";
import { MODULE_ID } from "./engine";

const BASE = "/m/integration-hub";
const n = (v: unknown) => Number(v ?? 0) || 0;

/** Automation volume for cross-module analytics (live executions only; test runs excluded). */
export function integrationInsights(platform: Pick<Platform, "db">): InsightProvider {
  return {
    moduleId: MODULE_ID,
    label: "Integration",
    async collect(ctx) {
      const r = await platform.db.withTenant({ organizationId: ctx.organizationId }, (tx) => tx.execute(sql`
        select
          count(*) filter (where status = 'succeeded') as succeeded,
          count(*) filter (where status in ('failed','partially_failed')) as failed,
          (select count(*) from integration_workflows where organization_id = ${ctx.organizationId}) as workflows
        from integration_executions
        where organization_id = ${ctx.organizationId} and mode = 'live' and created_at >= now() - interval '30 days'`));
      const row = (r.rows[0] ?? {}) as Record<string, unknown>;
      return [
        { key: "automation.executions_30d", label: "Successful automated executions (30 days)", value: n(row.succeeded), unit: "count", basis: "measured", href: `${BASE}/executions` },
        { key: "automation.failed_30d", label: "Failed executions (30 days)", value: n(row.failed), unit: "count", basis: "measured", href: `${BASE}/executions` },
        { key: "automation.workflows", label: "Integration workflows", value: n(row.workflows), unit: "count", basis: "measured", href: `${BASE}/workflows` },
      ];
    },
  };
}
