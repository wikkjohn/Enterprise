import { sql } from "@eaop/db";
import { type InsightProvider, type Platform } from "@eaop/platform";
import { MODULE_ID } from "./service";

const BASE = "/m/knowledge-verification";
const n = (v: unknown) => Number(v ?? 0) || 0;

/** Knowledge usage and answer quality for cross-module analytics. Counts only — never question text. */
export function knowledgeInsights(platform: Pick<Platform, "db">): InsightProvider {
  return {
    moduleId: MODULE_ID,
    label: "Knowledge & Verification",
    async collect(ctx) {
      const r = await platform.db.withTenant({ organizationId: ctx.organizationId }, (tx) => tx.execute(sql`
        select
          count(*) as questions,
          count(*) filter (where a.confidence in ('low','insufficient')) as low_conf,
          count(*) filter (where q.status = 'escalated') as escalated,
          (select count(*) from knowledge_documents where organization_id = ${ctx.organizationId} and status = 'active') as documents
        from knowledge_queries q left join knowledge_answers a on a.query_id = q.id
        where q.organization_id = ${ctx.organizationId} and q.created_at >= now() - interval '30 days'`));
      const row = (r.rows[0] ?? {}) as Record<string, unknown>;
      return [
        { key: "knowledge.questions_30d", label: "Questions answered (30 days)", value: n(row.questions), unit: "count", basis: "measured", href: `${BASE}/analytics` },
        { key: "knowledge.low_confidence_30d", label: "Low-confidence answers (30 days)", value: n(row.low_conf), unit: "count", basis: "measured", href: `${BASE}/analytics` },
        { key: "knowledge.escalated_30d", label: "Escalated to experts (30 days)", value: n(row.escalated), unit: "count", basis: "measured", href: `${BASE}/reviews` },
        { key: "knowledge.documents", label: "Active knowledge documents", value: n(row.documents), unit: "count", basis: "measured", href: `${BASE}/documents` },
      ];
    },
  };
}
