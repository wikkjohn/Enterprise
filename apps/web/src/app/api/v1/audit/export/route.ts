import { auditQuerySchema, AuditActions } from "@eaop/audit";
import { route } from "@/lib/api";

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  // Neutralise spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

export const GET = route({
  auth: "any",
  permission: "audit.export",
  rateLimit: { limit: 10, windowSeconds: 300 },
  query: auditQuerySchema,
  handler: async ({ platform, ctx, query }) => {
    const rows = [];
    let cursor: string | undefined;
    do {
      const page = await platform.audit.query(ctx, { ...query, limit: 500, cursor });
      rows.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor && rows.length < 50_000);
    await platform.audit.record(ctx, { action: AuditActions.DATA_EXPORTED, resourceType: "audit_log", metadata: { rows: rows.length, filters: { ...query, cursor: undefined } } });
    const cols = ["occurredAt", "actorType", "actorId", "actorLabel", "module", "action", "resourceType", "resourceId", "outcome", "ip", "userAgent", "correlationId", "before", "after", "metadata"] as const;
    const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n");
    return new Response(csv, { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"` } });
  },
});
