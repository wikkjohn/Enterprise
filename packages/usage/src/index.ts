import { z } from "zod";
import { and, eq, gte, lt, organizationSettings, scopeOf, sql, usageEvents, type Database } from "@eaop/db";
import { type EventBus } from "@eaop/events";
import { type JobQueue } from "@eaop/jobs";
import { type Authorizer } from "@eaop/rbac";
import { type OwnerId, type TenantContext } from "@eaop/shared-types";

/** Canonical metric names. Modules may record additional namespaced metrics ("workflow.analyses"). */
export const USAGE_METRICS = {
  API_REQUESTS: { key: "api.requests", unit: "request" },
  AI_INPUT_TOKENS: { key: "ai.input_tokens", unit: "token" },
  AI_OUTPUT_TOKENS: { key: "ai.output_tokens", unit: "token" },
  AI_COST: { key: "ai.cost", unit: "usd" },
  AI_RUNS: { key: "ai.runs", unit: "run" },
  CONNECTOR_ACTIONS: { key: "connector.actions", unit: "action" },
  STORAGE: { key: "storage.bytes", unit: "byte" },
  JOBS: { key: "jobs.executed", unit: "job" },
  EXECUTIONS: { key: "executions", unit: "execution" },
} as const;

export interface UsageRecord {
  moduleId: OwnerId;
  metric: string;
  quantity: number;
  unit: string;
  userId?: string | null;
  connectorId?: string | null;
  agentId?: string | null;
  aiProvider?: string | null;
  aiModel?: string | null;
  workflowId?: string | null;
  endpoint?: string | null;
  dimensions?: Record<string, string>;
  /** Set when a producer may retry, to avoid double counting. */
  dedupeKey?: string;
  occurredAt?: Date;
}

export const usageSummarySchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  groupBy: z.enum(["metric", "module", "day", "ai_provider", "ai_model", "user", "connector", "agent", "workflow", "endpoint"]).default("metric"),
  metric: z.string().max(120).optional(),
  moduleId: z.string().max(64).optional(),
});
export type UsageSummaryQuery = z.infer<typeof usageSummarySchema>;

export interface UsageSummaryRow {
  key: string | null;
  metric: string;
  unit: string;
  quantity: number;
}

export interface UsageService {
  record(ctx: TenantContext, records: UsageRecord | UsageRecord[]): Promise<void>;
  summary(ctx: TenantContext, q: UsageSummaryQuery): Promise<UsageSummaryRow[]>;
  monthToDate(ctx: TenantContext, metric: string): Promise<number>;
}

const GROUP_COLUMNS = {
  metric: null,
  module: usageEvents.moduleId,
  day: sql<string>`to_char(date_trunc('day', ${usageEvents.occurredAt}), 'YYYY-MM-DD')`,
  ai_provider: usageEvents.aiProvider,
  ai_model: usageEvents.aiModel,
  user: usageEvents.userId,
  connector: usageEvents.connectorId,
  agent: usageEvents.agentId,
  workflow: usageEvents.workflowId,
  endpoint: usageEvents.endpoint,
} as const;

function monthStart(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export function createUsageService(deps: { db: Database; authorizer: Authorizer; bus: EventBus; jobs: JobQueue }): UsageService {
  const { db, authorizer, bus, jobs } = deps;

  async function monthToDate(ctx: TenantContext, metric: string) {
    const [r] = await db.withTenant(scopeOf(ctx), (tx) =>
      tx
        .select({ q: sql<string>`coalesce(sum(${usageEvents.quantity}), 0)` })
        .from(usageEvents)
        .where(and(eq(usageEvents.organizationId, ctx.organizationId), eq(usageEvents.metric, metric), gte(usageEvents.occurredAt, monthStart()))),
    );
    return Number(r?.q ?? 0);
  }

  jobs.register({
    type: "usage.threshold_alert",
    maxAttempts: 3,
    async handle(job) {
      const p = job.payload as { metric: string; limit: number; current: number; period: string };
      const ctx: TenantContext = { organizationId: job.organizationId!, actor: { type: "system", id: "usage", label: "system:usage" }, correlationId: job.correlationId ?? job.id };
      await bus.publish(ctx, "usage.threshold.exceeded", p);
    },
  });

  async function checkThresholds(ctx: TenantContext, metrics: Set<string>) {
    const [settings] = await db.withTenant(scopeOf(ctx), (tx) =>
      tx.select({ limits: organizationSettings.usageLimits }).from(organizationSettings).where(eq(organizationSettings.organizationId, ctx.organizationId)).limit(1),
    );
    const limits = settings?.limits ?? {};
    const checks: Array<[string, number | undefined]> = [
      [USAGE_METRICS.AI_COST.key, limits.monthlyAiCostUsd],
      [USAGE_METRICS.AI_INPUT_TOKENS.key, limits.monthlyAiTokens],
    ];
    const period = monthStart().toISOString().slice(0, 7);
    for (const [metric, limit] of checks) {
      if (!limit || !metrics.has(metric)) continue;
      const current = await monthToDate(ctx, metric);
      if (current >= limit) {
        // Idempotency key ⇒ at most one alert per org/metric/month.
        await jobs.enqueue("usage.threshold_alert", { metric, limit, current, period }, { organizationId: ctx.organizationId, idempotencyKey: `${ctx.organizationId}:${metric}:${period}` });
      }
    }
  }

  return {
    async record(ctx, input) {
      const list = Array.isArray(input) ? input : [input];
      if (list.length === 0) return;
      await db.withTenant(scopeOf(ctx), (tx) =>
        tx
          .insert(usageEvents)
          .values(
            list.map((r) => ({
              organizationId: ctx.organizationId,
              occurredAt: r.occurredAt ?? new Date(),
              moduleId: r.moduleId,
              metric: r.metric,
              quantity: String(r.quantity),
              unit: r.unit,
              userId: r.userId ?? null,
              connectorId: r.connectorId ?? null,
              agentId: r.agentId ?? null,
              aiProvider: r.aiProvider ?? null,
              aiModel: r.aiModel ?? null,
              workflowId: r.workflowId ?? null,
              endpoint: r.endpoint ?? null,
              dimensions: r.dimensions ?? {},
              dedupeKey: r.dedupeKey ?? null,
            })),
          )
          .onConflictDoNothing(),
      );
      await checkThresholds(ctx, new Set(list.map((r) => r.metric)));
    },

    async summary(ctx, raw) {
      await authorizer.require(ctx, "usage.read");
      const q = usageSummarySchema.parse(raw);
      const col = GROUP_COLUMNS[q.groupBy];
      const conds = [eq(usageEvents.organizationId, ctx.organizationId), gte(usageEvents.occurredAt, q.from), lt(usageEvents.occurredAt, q.to)];
      if (q.metric) conds.push(eq(usageEvents.metric, q.metric));
      if (q.moduleId) conds.push(eq(usageEvents.moduleId, q.moduleId));
      const keyExpr = col ? sql<string | null>`${col}::text` : sql<string | null>`'all'`;
      const groupCols = col ? [keyExpr, usageEvents.metric, usageEvents.unit] : [usageEvents.metric, usageEvents.unit];
      const rows = await db.withTenant(scopeOf(ctx), (tx) =>
        tx
          .select({ key: keyExpr, metric: usageEvents.metric, unit: usageEvents.unit, quantity: sql<string>`sum(${usageEvents.quantity})` })
          .from(usageEvents)
          .where(and(...conds))
          .groupBy(...groupCols)
          .orderBy(...groupCols),
      );
      return rows.map((r) => ({ key: col ? r.key : null, metric: r.metric, unit: r.unit, quantity: Number(r.quantity) }));
    },

    async monthToDate(ctx, metric) {
      await authorizer.require(ctx, "usage.read");
      return monthToDate(ctx, metric);
    },
  };
}
