import { z } from "zod";
import { and, desc, eq, inArray, sql, type Tx } from "@eaop/db";
import { AppError, conflict, notFound, type TenantContext } from "@eaop/shared-types";
import { addDays, BASE, daysBetween, iso, isoDay, parse, text, today, type Base } from "./base";
import { allocate, budgetStatus, periodWindow, round2, runRateForecast, trendForecast, type BudgetPeriod } from "./budget";
import { addCost, emptyCost, totalCost, type CostByBasis } from "./economics";
import {
  aiBudgets, aiCostForecasts, aiCostRecords, aiOpsSettings, aiTools, aiVendorContracts, aiVendors, BUDGET_SCOPES, COST_BASES, COST_CATEGORIES,
  type BudgetScope, type CostBasis, type CostCategory,
} from "./schema";

/**
 * The cost ledger. Spend comes from three places, never copied between them:
 *  1. ai_cost_records — invoices, subscriptions, services (measured), entered
 *     estimates, and allocation children (allocated). Prorated by day.
 *  2. usage_events (shared metering) — platform AI inference cost, measured.
 *  3. Active contracts — an *estimated* run-rate for months in which no cost
 *     record references the contract.
 */

export interface CostLine {
  month: string;
  amount: number;
  basis: CostBasis;
  category: CostCategory;
  source: "record" | "metered" | "contract";
  department: string | null;
  toolId: string | null;
  vendorId: string | null;
  contractId: string | null;
  provider: string | null;
  model: string | null;
  agentId: string | null;
  workflowId: string | null;
  project: string | null;
  module: string | null;
  userId: string | null;
}

export const COST_DIMENSIONS = ["month", "category", "basis", "department", "tool", "vendor", "provider", "model", "agent", "workflow", "project", "module", "user"] as const;
export type CostDimension = (typeof COST_DIMENSIONS)[number];

const dimKey = (l: CostLine, d: CostDimension): string | null =>
  ({ month: l.month, category: l.category, basis: l.basis, department: l.department, tool: l.toolId, vendor: l.vendorId, provider: l.provider, model: l.model ? `${l.provider ?? "?"}/${l.model}` : null, agent: l.agentId, workflow: l.workflowId, project: l.project, module: l.module, user: l.userId })[d];

const monthsBetween = (from: string, to: string) => {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7)) - 1;
  while (true) {
    const key = `${y}-${String(m + 1).padStart(2, "0")}`;
    if (`${key}-01` >= to) break;
    out.push(key);
    m++;
    if (m === 12) { m = 0; y++; }
  }
  return out;
};
const monthStart = (key: string) => `${key}-01`;
const monthEnd = (key: string) => {
  const [y, m] = key.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
};
/** Days of [a, b) inside [c, d). */
const overlap = (a: string, b: string, c: string, d: string) => Math.max(0, daysBetween(a > c ? a : c, b < d ? b : d));

/** Split a record's amount over the months of [from, to) it overlaps, by day. */
export function prorate(rec: { periodStart: string; periodEnd: string; amount: number }, from: string, to: string): Array<{ month: string; amount: number }> {
  const end = addDays(rec.periodEnd, 1); // stored inclusive
  const total = Math.max(1, daysBetween(rec.periodStart, end));
  return monthsBetween(rec.periodStart.slice(0, 7) + "-01" < from ? from : rec.periodStart.slice(0, 7) + "-01", to)
    .map((month) => ({ month, amount: (rec.amount * overlap(rec.periodStart, end, monthStart(month) < from ? from : monthStart(month), monthEnd(month) > to ? to : monthEnd(month))) / total }))
    .filter((x) => x.amount !== 0);
}

const recordSchema = z.object({
  periodStart: isoDay, periodEnd: isoDay, amountUsd: z.number().finite().min(-1e10).max(1e10), category: z.enum(COST_CATEGORIES), basis: z.enum(["measured", "estimated"]).default("measured"),
  description: text(500).default(""), toolId: z.string().uuid().nullish(), vendorId: z.string().uuid().nullish(), contractId: z.string().uuid().nullish(), department: text(120).nullish(),
  providerKey: text(120).nullish(), modelKey: text(200).nullish(), agentId: text(120).nullish(), workflowId: text(120).nullish(), project: text(120).nullish(), userId: z.string().uuid().nullish(),
  externalRef: text(200).nullish(),
}).refine((r) => r.periodEnd >= r.periodStart, "periodEnd must not be before periodStart");

const budgetSchema = z.object({
  name: text(160).min(1), scope: z.enum(BUDGET_SCOPES), scopeValue: text(200).nullish(), period: z.enum(["monthly", "quarterly", "annual"]),
  amountUsd: z.number().finite().positive().max(1e10), thresholds: z.array(z.number().int().min(1).max(500)).max(6).default([80, 100]), ownerUserId: z.string().uuid().nullish(),
}).refine((b) => b.scope === "organization" || !!b.scopeValue, "scopeValue is required for this scope");

export function makeCosts(b: Base) {
  const { deps } = b;

  async function settings(orgId: string) {
    return b.orgScope(orgId, async (tx) => {
      const [s] = await tx.select().from(aiOpsSettings).where(eq(aiOpsSettings.organizationId, orgId)).limit(1);
      if (s) return s;
      await tx.insert(aiOpsSettings).values({ organizationId: orgId }).onConflictDoNothing();
      return (await tx.select().from(aiOpsSettings).where(eq(aiOpsSettings.organizationId, orgId)).limit(1))[0]!;
    });
  }

  /** Every cost line in [from, to) (YYYY-MM-DD, `to` exclusive). Internal — callers check permissions. */
  async function lines(orgId: string, from: string, to: string): Promise<CostLine[]> {
    return b.orgScope(orgId, async (tx) => {
      const out: CostLine[] = [];
      const recs = await tx.select().from(aiCostRecords).where(and(eq(aiCostRecords.organizationId, orgId), eq(aiCostRecords.status, "active"), sql`${aiCostRecords.periodEnd} >= ${from}::date and ${aiCostRecords.periodStart} < ${to}::date`));
      const covered = new Set<string>();
      for (const r of recs) {
        for (const p of prorate({ periodStart: r.periodStart, periodEnd: r.periodEnd, amount: r.amountUsd }, from, to)) {
          if (r.contractId) covered.add(`${r.contractId}:${p.month}`);
          if (r.vendorId && (r.category === "subscription" || r.category === "api")) covered.add(`vendor:${r.vendorId}:${p.month}`);
          out.push({ month: p.month, amount: p.amount, basis: r.basis, category: r.category, source: "record", department: r.department, toolId: r.toolId, vendorId: r.vendorId, contractId: r.contractId, provider: r.providerKey, model: r.modelKey, agentId: r.agentId, workflowId: r.workflowId, project: r.project, module: null, userId: r.userId });
        }
      }
      // Platform AI inference, metered by the shared usage service.
      const vendors = await tx.select({ id: aiVendors.id, keys: aiVendors.platformProviderKeys }).from(aiVendors).where(eq(aiVendors.organizationId, orgId));
      const vendorFor = (provider: string | null) => (provider ? vendors.find((v) => v.keys.includes(provider))?.id ?? null : null);
      const metered = await tx.execute(sql`
        select to_char(date_trunc('month', e.occurred_at), 'YYYY-MM') as month, e.module_id, e.ai_provider, e.ai_model, e.agent_id, e.workflow_id, e.user_id, m.department, sum(e.quantity)::float8 as amount
        from usage_events e left join memberships m on m.user_id = e.user_id and m.organization_id = e.organization_id
        where e.organization_id = ${orgId} and e.metric = 'ai.cost' and e.occurred_at >= ${from}::date and e.occurred_at < ${to}::date
        group by 1, 2, 3, 4, 5, 6, 7, 8`);
      for (const r of metered.rows as Array<Record<string, string | number | null>>) {
        out.push({ month: String(r.month), amount: Number(r.amount), basis: "measured", category: "inference", source: "metered", department: (r.department as string) ?? null, toolId: null, vendorId: vendorFor(r.ai_provider as string), contractId: null, provider: (r.ai_provider as string) ?? null, model: (r.ai_model as string) ?? null, agentId: (r.agent_id as string) ?? null, workflowId: (r.workflow_id as string) ?? null, project: null, module: (r.module_id as string) ?? null, userId: (r.user_id as string) ?? null });
      }
      // Contract run-rate where nothing has been recorded against the contract.
      // Usage-billed contracts are paid through metered usage or invoices, so a run-rate estimate would double count them.
      const contracts = await tx.select().from(aiVendorContracts).where(and(eq(aiVendorContracts.organizationId, orgId), eq(aiVendorContracts.status, "active"), sql`${aiVendorContracts.annualValue} > 0 and ${aiVendorContracts.billingFrequency} <> 'usage'`));
      const tools = contracts.length ? await tx.select({ id: aiTools.id, contractId: aiTools.contractId, departments: aiTools.departments }).from(aiTools).where(inArray(aiTools.contractId, contracts.map((c) => c.id))) : [];
      const now = today();
      for (const c of contracts) {
        const cStart = c.startDate ?? from;
        const cEnd = c.endDate ? addDays(c.endDate, 1) : "9999-12-31";
        const linked = tools.filter((t) => t.contractId === c.id);
        const dept = linked.length === 1 && linked[0]!.departments.length === 1 ? linked[0]!.departments[0]! : null;
        for (const month of monthsBetween(from, to)) {
          if (covered.has(`${c.id}:${month}`) || covered.has(`vendor:${c.vendorId}:${month}`)) continue;
          const a = monthStart(month) < from ? from : monthStart(month);
          const z = [monthEnd(month), to, cEnd, addDays(now, 1)].sort()[0]!; // never estimate the future as spend
          const days = overlap(cStart, cEnd, a, z);
          if (days <= 0) continue;
          out.push({ month, amount: (c.annualValue * days) / 365, basis: "estimated", category: "subscription", source: "contract", department: dept, toolId: linked[0]?.id ?? null, vendorId: c.vendorId, contractId: c.id, provider: null, model: null, agentId: null, workflowId: null, project: null, module: null, userId: null });
        }
      }
      return out;
    });
  }

  function group(ls: CostLine[], dim: CostDimension) {
    const map = new Map<string, CostByBasis>();
    for (const l of ls) {
      const k = dimKey(l, dim) ?? "(unassigned)";
      map.set(k, addCost(map.get(k) ?? emptyCost(), { [l.basis]: l.amount }));
    }
    return [...map.entries()].map(([key, c]) => ({ key, measured: round2(c.measured), estimated: round2(c.estimated), allocated: round2(c.allocated), total: round2(totalCost(c)) })).sort((a, c) => (dim === "month" ? a.key.localeCompare(c.key) : c.total - a.total));
  }

  async function labels(orgId: string, dim: CostDimension, keys: string[]) {
    const ids = keys.filter((k) => /^[0-9a-f-]{36}$/.test(k));
    if (!ids.length) return new Map<string, string>();
    return b.orgScope(orgId, async (tx) => {
      const rows = dim === "tool" ? await tx.select({ id: aiTools.id, name: aiTools.name }).from(aiTools).where(inArray(aiTools.id, ids))
        : dim === "vendor" ? await tx.select({ id: aiVendors.id, name: aiVendors.name }).from(aiVendors).where(inArray(aiVendors.id, ids))
        : dim === "user" ? ((await tx.execute(sql`select id, name from users where id = any(${`{${ids.join(",")}}`}::uuid[])`)).rows as Array<{ id: string; name: string }>)
        : [];
      return new Map(rows.map((r) => [r.id, r.name]));
    });
  }

  const matchesScope = (l: CostLine, scope: BudgetScope, value: string | null) =>
    scope === "organization" || ({ department: l.department, tool: l.toolId, vendor: l.vendorId, provider: l.provider, model: l.model, category: l.category, project: l.project } as Record<string, string | null>)[scope] === value;

  async function budgetView(orgId: string, bud: typeof aiBudgets.$inferSelect, now = new Date()) {
    const st = await settings(orgId);
    const w = periodWindow(bud.period as BudgetPeriod, now, st.fiscalYearStartMonth);
    const ls = (await lines(orgId, w.start.toISOString().slice(0, 10), w.end.toISOString().slice(0, 10))).filter((l) => matchesScope(l, bud.scope, bud.scopeValue));
    const spent = ls.reduce((a, l) => a + l.amount, 0);
    const s = budgetStatus({ amount: bud.amountUsd, spent, projected: runRateForecast(spent, w, now), thresholds: bud.thresholds });
    const byBasis = ls.reduce((c, l) => addCost(c, { [l.basis]: l.amount }), emptyCost());
    return { id: bud.id, name: bud.name, scope: bud.scope, scopeValue: bud.scopeValue, period: bud.period, periodKey: w.key, periodLabel: w.label, periodStart: w.start.toISOString().slice(0, 10), periodEnd: w.end.toISOString().slice(0, 10), thresholds: bud.thresholds, ownerUserId: bud.ownerUserId, lifecycle: bud.status, ...s, byBasis: { measured: round2(byBasis.measured), estimated: round2(byBasis.estimated), allocated: round2(byBasis.allocated) } };
  }

  const recordView = (r: typeof aiCostRecords.$inferSelect) => ({ ...r, createdAt: r.createdAt.toISOString() });

  async function allocationWeights(tx: Tx, orgId: string, rec: typeof aiCostRecords.$inferSelect, method: "seats" | "headcount" | "ai_usage") {
    const rows = method === "seats"
      ? (await tx.execute(sql`select coalesce(m.department, 'Unassigned') as k, count(*)::float8 as w from ai_tool_licenses l join memberships m on m.user_id = l.user_id and m.organization_id = l.organization_id where l.organization_id = ${orgId} and l.status = 'active' and (${rec.toolId}::uuid is null or l.tool_id = ${rec.toolId}::uuid) group by 1`)).rows
      : method === "headcount"
        ? (await tx.execute(sql`select coalesce(department, 'Unassigned') as k, count(*)::float8 as w from memberships where organization_id = ${orgId} and status = 'active' group by 1`)).rows
        : (await tx.execute(sql`select coalesce(m.department, 'Unassigned') as k, sum(e.quantity)::float8 as w from usage_events e left join memberships m on m.user_id = e.user_id and m.organization_id = e.organization_id where e.organization_id = ${orgId} and e.metric = 'ai.cost' and e.occurred_at >= ${rec.periodStart}::date and e.occurred_at < ${addDays(rec.periodEnd, 1)}::date group by 1`)).rows;
    return Object.fromEntries((rows as Array<{ k: string; w: number }>).map((r) => [r.k, Number(r.w)]));
  }

  async function refreshForecast(orgId: string, now = new Date()) {
      const thisMonth = now.toISOString().slice(0, 7);
      const from = `${Number(thisMonth.slice(0, 4)) - 1}${thisMonth.slice(4)}-01`;
      const ls = await lines(orgId, from, `${thisMonth}-01`);
      const months = monthsBetween(from, `${thisMonth}-01`);
      const totals = months.map((m) => ls.filter((l) => l.month === m).reduce((a, l) => a + l.amount, 0));
      const firstSpend = totals.findIndex((v) => v > 0);
      const history = firstSpend === -1 ? [] : totals.slice(firstSpend);
      const f = trendForecast(history, 3);
      const ahead = [0, 1, 2].map((k) => {
        const d = new Date(Date.UTC(Number(thisMonth.slice(0, 4)), Number(thisMonth.slice(5, 7)) - 1 + k, 1));
        return d.toISOString().slice(0, 10);
      });
      await b.orgScope(orgId, async (tx) => {
        for (let i = 0; i < 3; i++) {
          await tx.insert(aiCostForecasts).values({ organizationId: orgId, scope: "organization", scopeValue: "", month: ahead[i]!, method: f.method, forecastUsd: f.values[i]!, lowUsd: f.low[i]!, highUsd: f.high[i]!, note: f.note })
            .onConflictDoUpdate({ target: [aiCostForecasts.organizationId, aiCostForecasts.scope, aiCostForecasts.scopeValue, aiCostForecasts.month], set: { method: f.method, forecastUsd: f.values[i]!, lowUsd: f.low[i]!, highUsd: f.high[i]!, note: f.note, generatedAt: new Date() } });
        }
      });
      return f;
    }

  return {
    settings, lines, group, refreshForecast,

    // ── Forecasts ─────────────────────────────────────────────────────────

    async breakdown(ctx: TenantContext, q: { from?: string; to?: string; by?: string; basis?: string }) {
      await b.require(ctx, "ai_ops.cost.read");
      const to = q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? q.to : addDays(today(), 1);
      const from = q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? q.from : `${Number(to.slice(0, 4)) - 1}${to.slice(4, 7)}-01`;
      if (from >= to) throw new AppError("VALIDATION_FAILED", "from must be before to.");
      const by = (COST_DIMENSIONS as readonly string[]).includes(q.by ?? "") ? (q.by as CostDimension) : "category";
      if (by === "user") await b.require(ctx, "ai_ops.admin");
      const all = await lines(b.org(ctx), from, to);
      const ls = q.basis && (COST_BASES as readonly string[]).includes(q.basis) ? all.filter((l) => l.basis === q.basis) : all;
      const rows = group(ls, by);
      const names = await labels(b.org(ctx), by, rows.map((r) => r.key));
      const totals = ls.reduce((c, l) => addCost(c, { [l.basis]: l.amount }), emptyCost());
      return {
        from, to, by,
        totals: { measured: round2(totals.measured), estimated: round2(totals.estimated), allocated: round2(totals.allocated), total: round2(totalCost(totals)) },
        rows: rows.map((r) => ({ ...r, label: names.get(r.key) ?? r.key })),
        trend: group(ls, "month"),
      };
    },

    async listRecords(ctx: TenantContext, q: { from?: string; to?: string } = {}) {
      await b.require(ctx, "ai_ops.cost.read");
      const rows = await b.tenant(ctx, (tx) => tx.select().from(aiCostRecords).where(and(eq(aiCostRecords.organizationId, b.org(ctx)), q.from ? sql`${aiCostRecords.periodEnd} >= ${q.from}::date` : undefined, q.to ? sql`${aiCostRecords.periodStart} < ${q.to}::date` : undefined)).orderBy(desc(aiCostRecords.periodStart), desc(aiCostRecords.createdAt)).limit(1000));
      return rows.map(recordView);
    },

    async addRecords(ctx: TenantContext, raw: unknown) {
      await b.require(ctx, "ai_ops.cost.manage");
      const items = parse(z.array(recordSchema).min(1).max(1000), Array.isArray(raw) ? raw : (raw as { records?: unknown })?.records ?? [raw]);
      const res = await b.tenant(ctx, async (tx) => {
        let inserted = 0;
        let duplicates = 0;
        for (const r of items) {
          await b.assertMember(tx, b.org(ctx), r.userId, "userId");
          const [row] = await tx.insert(aiCostRecords).values({ ...r, organizationId: b.org(ctx), source: ctx.actor.type === "user" ? "manual" : "api", createdBy: b.userId(ctx) }).onConflictDoNothing().returning({ id: aiCostRecords.id });
          if (row) inserted++;
          else duplicates++;
        }
        return { inserted, duplicates };
      });
      await b.record(ctx, "ai_ops.cost_records_added", "ai_cost_record", b.org(ctx), { metadata: { ...res, total: round2(items.reduce((a, r) => a + r.amountUsd, 0)) } });
      return res;
    },

    async voidRecord(ctx: TenantContext, id: string) {
      await b.require(ctx, "ai_ops.cost.manage");
      b.uuidOr404(id, "Cost record");
      const [r] = await b.tenant(ctx, (tx) => tx.update(aiCostRecords).set({ status: "void" }).where(and(eq(aiCostRecords.organizationId, b.org(ctx)), eq(aiCostRecords.id, id), eq(aiCostRecords.status, "active"))).returning());
      if (!r) throw notFound("Cost record", id);
      await b.record(ctx, "ai_ops.cost_record_voided", "ai_cost_record", id, { before: { amountUsd: r.amountUsd, category: r.category } });
      return recordView(r);
    },

    /**
     * Allocate a shared cost to departments. The parent stays for the audit
     * trail but stops counting; the children carry basis "allocated".
     */
    async allocateRecord(ctx: TenantContext, id: string, raw: unknown) {
      await b.require(ctx, "ai_ops.cost.manage");
      b.uuidOr404(id, "Cost record");
      const input = parse(z.object({ method: z.enum(["seats", "headcount", "ai_usage", "custom"]), weights: z.record(z.number().min(0)).optional() }), raw);
      const res = await b.tenant(ctx, async (tx) => {
        const [rec] = await tx.select().from(aiCostRecords).where(and(eq(aiCostRecords.organizationId, b.org(ctx)), eq(aiCostRecords.id, id))).limit(1);
        if (!rec) throw notFound("Cost record", id);
        if (rec.status !== "active" || rec.parentId) throw conflict("Only an active, unallocated cost record can be allocated.");
        if (rec.amountUsd <= 0) throw new AppError("VALIDATION_FAILED", "Only positive amounts can be allocated.");
        const weights = input.method === "custom" ? input.weights ?? {} : await allocationWeights(tx, b.org(ctx), rec, input.method);
        const shares = allocate(rec.amountUsd, weights);
        if (!Object.keys(shares).length) throw new AppError("VALIDATION_FAILED", `Nothing to allocate by ${input.method.replace("_", " ")}: no departments have a weight.`);
        for (const [department, amount] of Object.entries(shares)) {
          await tx.insert(aiCostRecords).values({
            organizationId: b.org(ctx), periodStart: rec.periodStart, periodEnd: rec.periodEnd, amountUsd: amount, category: rec.category, basis: "allocated", source: "allocation",
            description: `${rec.description || rec.category} — allocated by ${input.method.replace("_", " ")}`, toolId: rec.toolId, vendorId: rec.vendorId, contractId: rec.contractId,
            department, providerKey: rec.providerKey, modelKey: rec.modelKey, project: rec.project, parentId: rec.id, createdBy: b.userId(ctx),
          });
        }
        await tx.update(aiCostRecords).set({ status: "allocated" }).where(eq(aiCostRecords.id, rec.id));
        return { shares, method: input.method };
      });
      await b.record(ctx, "ai_ops.cost_allocated", "ai_cost_record", id, { after: res });
      return res;
    },

    async unallocateRecord(ctx: TenantContext, id: string) {
      await b.require(ctx, "ai_ops.cost.manage");
      b.uuidOr404(id, "Cost record");
      await b.tenant(ctx, async (tx) => {
        const [rec] = await tx.select().from(aiCostRecords).where(and(eq(aiCostRecords.organizationId, b.org(ctx)), eq(aiCostRecords.id, id), eq(aiCostRecords.status, "allocated"))).limit(1);
        if (!rec) throw notFound("Allocated cost record", id);
        await tx.delete(aiCostRecords).where(eq(aiCostRecords.parentId, id));
        await tx.update(aiCostRecords).set({ status: "active" }).where(eq(aiCostRecords.id, id));
      });
      await b.record(ctx, "ai_ops.cost_unallocated", "ai_cost_record", id);
      return { ok: true };
    },

    // ── Budgets ───────────────────────────────────────────────────────────
    async listBudgets(ctx: TenantContext) {
      await b.require(ctx, "ai_ops.cost.read");
      const rows = await b.tenant(ctx, (tx) => tx.select().from(aiBudgets).where(and(eq(aiBudgets.organizationId, b.org(ctx)), eq(aiBudgets.status, "active"))).orderBy(aiBudgets.name));
      const out = [];
      for (const r of rows) out.push(await budgetView(b.org(ctx), r));
      return out;
    },
    async saveBudget(ctx: TenantContext, id: string | null, raw: unknown) {
      await b.require(ctx, "ai_ops.cost.manage");
      const input = parse(id ? budgetSchema.innerType().partial().extend({ status: z.enum(["active", "archived"]).optional() }) : budgetSchema, raw);
      const row = await b.tenant(ctx, async (tx) => {
        await b.assertMember(tx, b.org(ctx), input.ownerUserId, "Owner");
        const values = { ...input, scopeValue: input.scope === "organization" ? null : input.scopeValue, thresholds: input.thresholds ? [...new Set(input.thresholds)].sort((x, y) => x - y) : undefined };
        if (!id) {
          const [dup] = await tx.select({ id: aiBudgets.id }).from(aiBudgets).where(and(eq(aiBudgets.organizationId, b.org(ctx)), eq(aiBudgets.name, input.name!))).limit(1);
          if (dup) throw conflict(`A budget named "${input.name}" already exists.`);
          const create = values as z.output<typeof budgetSchema>;
          return (await tx.insert(aiBudgets).values({ name: create.name, scope: create.scope, scopeValue: create.scopeValue ?? null, period: create.period, amountUsd: create.amountUsd, thresholds: create.thresholds, ownerUserId: create.ownerUserId ?? null, organizationId: b.org(ctx), createdBy: b.userId(ctx) }).returning())[0]!;
        }
        b.uuidOr404(id, "Budget");
        const [u] = await tx.update(aiBudgets).set({ ...values, updatedAt: new Date() }).where(and(eq(aiBudgets.organizationId, b.org(ctx)), eq(aiBudgets.id, id))).returning();
        if (!u) throw notFound("Budget", id);
        return u;
      });
      await b.record(ctx, id ? "ai_ops.budget_updated" : "ai_ops.budget_created", "ai_budget", row.id, { after: input });
      return budgetView(b.org(ctx), row);
    },

    /** Daily: alert once per threshold per budget period. */
    async checkBudgets(orgId: string, now = new Date()) {
      const ctx = b.sysCtx(orgId);
      const rows = await b.orgScope(orgId, (tx) => tx.select().from(aiBudgets).where(and(eq(aiBudgets.organizationId, orgId), eq(aiBudgets.status, "active"))));
      let alerts = 0;
      for (const r of rows) {
        const v = await budgetView(orgId, r, now);
        const already = r.alerted[v.periodKey] ?? [];
        const fresh = v.crossed.filter((t) => !already.includes(t));
        if (!fresh.length) continue;
        const top = Math.max(...fresh);
        await b.orgScope(orgId, (tx) => tx.update(aiBudgets).set({ alerted: { ...Object.fromEntries(Object.entries(r.alerted).filter(([k]) => k === v.periodKey)), [v.periodKey]: [...already, ...fresh] } }).where(eq(aiBudgets.id, r.id)));
        await deps.bus.publish(ctx, "ai_ops.cost.threshold_exceeded", { budgetId: r.id, threshold: top, periodKey: v.periodKey, spent: v.spent, amount: v.amount });
        await deps.notifications.notify(ctx, {
          type: "ai_ops.budget_threshold", title: `${r.name}: ${top}% of the ${v.periodLabel} budget used`, body: `$${v.spent.toLocaleString("en-US")} of $${v.amount.toLocaleString("en-US")}; run-rate projects $${v.projected.toLocaleString("en-US")}.`,
          actionUrl: `${BASE}/costs?tab=budgets`, priority: top >= 100 ? "high" : "normal", recipients: r.ownerUserId ? { userIds: [r.ownerUserId] } : { permission: "ai_ops.cost.manage" },
        });
        await b.record(ctx, "ai_ops.budget_threshold_exceeded", "ai_budget", r.id, { metadata: { threshold: top, periodKey: v.periodKey, spent: v.spent, amount: v.amount } });
        alerts++;
      }
      return alerts;
    },

    async listForecasts(ctx: TenantContext) {
      await b.require(ctx, "ai_ops.cost.read");
      let rows = await b.tenant(ctx, (tx) => tx.select().from(aiCostForecasts).where(and(eq(aiCostForecasts.organizationId, b.org(ctx)), sql`${aiCostForecasts.month} >= date_trunc('month', now())::date`)).orderBy(aiCostForecasts.month));
      if (!rows.length) {
        await refreshForecast(b.org(ctx));
        rows = await b.tenant(ctx, (tx) => tx.select().from(aiCostForecasts).where(and(eq(aiCostForecasts.organizationId, b.org(ctx)), sql`${aiCostForecasts.month} >= date_trunc('month', now())::date`)).orderBy(aiCostForecasts.month));
      }
      return rows.map((r) => ({ month: r.month.slice(0, 7), method: r.method, forecastUsd: r.forecastUsd, lowUsd: r.lowUsd, highUsd: r.highUsd, note: r.note, basis: "estimated" as const, generatedAt: iso(r.generatedAt) }));
    },
  };
}

export type Costs = ReturnType<typeof makeCosts>;
