import { sql } from "@eaop/db";
import { type InsightProvider, type Platform } from "@eaop/platform";
import { MODULE_ID } from "./service";

const BASE = "/m/agent-governance";
const n = (v: unknown) => Number(v ?? 0) || 0;

/** Agent estate and risk summary for cross-module analytics. */
export function agentInsights(platform: Pick<Platform, "db">): InsightProvider {
  return {
    moduleId: MODULE_ID,
    label: "Agent Governance",
    async collect(ctx) {
      const r = await platform.db.withTenant({ organizationId: ctx.organizationId }, (tx) => tx.execute(sql`
        select
          count(*) filter (where status <> 'retired') as total,
          count(*) filter (where status = 'approved') as approved,
          count(*) filter (where status in ('unknown','pending')) as unreviewed,
          count(*) filter (where status <> 'retired' and risk_category in ('high','critical')) as high_risk,
          (select count(*) from agent_incidents where organization_id = ${ctx.organizationId} and status <> 'resolved') as open_incidents
        from agents where organization_id = ${ctx.organizationId}`));
      const row = (r.rows[0] ?? {}) as Record<string, unknown>;
      return [
        { key: "agents.total", label: "Agents (not retired)", value: n(row.total), unit: "count", basis: "measured", href: `${BASE}/agents` },
        { key: "agents.approved", label: "Approved agents", value: n(row.approved), unit: "count", basis: "measured", href: `${BASE}/agents` },
        { key: "agents.unreviewed", label: "Agents awaiting review", value: n(row.unreviewed), unit: "count", basis: "measured", href: `${BASE}/agents` },
        { key: "agents.high_risk", label: "High or critical risk agents", value: n(row.high_risk), unit: "count", basis: "measured", href: `${BASE}/agents` },
        { key: "incidents.open", label: "Open agent incidents", value: n(row.open_incidents), unit: "count", basis: "measured", href: `${BASE}/incidents` },
      ];
    },
  };
}
