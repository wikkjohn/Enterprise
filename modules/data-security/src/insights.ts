import { sql } from "@eaop/db";
import { type InsightProvider, type Platform } from "@eaop/platform";
import { MODULE_ID } from "./service";

const BASE = "/m/data-security";
const n = (v: unknown) => Number(v ?? 0) || 0;

/** Security posture and policy impact for cross-module analytics. */
export function securityInsights(platform: Pick<Platform, "db">): InsightProvider {
  return {
    moduleId: MODULE_ID,
    label: "Data Security",
    async collect(ctx) {
      const r = await platform.db.withTenant({ organizationId: ctx.organizationId }, (tx) => tx.execute(sql`
        select
          (select count(*) from security_incidents where organization_id = ${ctx.organizationId} and status <> 'resolved') as open_incidents,
          (select count(*) from security_incidents where organization_id = ${ctx.organizationId} and status <> 'resolved' and severity = 'critical') as critical,
          (select count(*) from dlp_events where organization_id = ${ctx.organizationId} and decision = 'BLOCK' and created_at >= now() - interval '30 days') as blocked,
          (select count(*) from dlp_events where organization_id = ${ctx.organizationId} and decision = 'REDACT' and created_at >= now() - interval '30 days') as redacted,
          (select count(*) from shadow_ai_tools where organization_id = ${ctx.organizationId} and status in ('unknown','restricted','blocked')) as shadow`));
      const row = (r.rows[0] ?? {}) as Record<string, unknown>;
      return [
        { key: "security.open_incidents", label: "Open security incidents", value: n(row.open_incidents), unit: "count", basis: "measured", href: `${BASE}/incidents` },
        { key: "security.critical_incidents", label: "Critical incidents open", value: n(row.critical), unit: "count", basis: "measured", href: `${BASE}/incidents` },
        { key: "dlp.blocked_30d", label: "AI transmissions blocked by DLP (30 days)", value: n(row.blocked), unit: "count", basis: "measured", href: `${BASE}/dlp` },
        { key: "dlp.redacted_30d", label: "AI transmissions redacted (30 days)", value: n(row.redacted), unit: "count", basis: "measured", href: `${BASE}/dlp` },
        { key: "shadow_ai.unapproved_tools", label: "Unapproved AI tools seen in use", value: n(row.shadow), unit: "count", basis: "measured", href: `${BASE}/shadow-ai` },
      ];
    },
  };
}
