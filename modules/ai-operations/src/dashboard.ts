import { and, eq, sql } from "@eaop/db";
import { type ModuleInsights } from "@eaop/platform";
import { type TenantContext } from "@eaop/shared-types";
import { addDays, BASE, today, type Base } from "./base";
import { round2 } from "./budget";
import { type Costs, type CostLine } from "./costs";
import { addCost, costPerValueDollar, emptyCost, totalCost, unitMetric, type CostByBasis } from "./economics";
import { type Governance } from "./governance";
import { type Inventory } from "./inventory";
import { type People } from "./people";
import { aiAdoptionMetrics, aiOptimizationFindings, aiRequests, aiTools, aiValueRecords, aiVendors } from "./schema";

const sumBasis = (ls: CostLine[]) => ls.reduce((c, l) => addCost(c, { [l.basis]: l.amount }), emptyCost());
const rounded = (c: CostByBasis) => ({ measured: round2(c.measured), estimated: round2(c.estimated), allocated: round2(c.allocated), total: round2(totalCost(c)) });
const metric = (insights: ModuleInsights[], key: string) => {
  for (const m of insights) {
    const x = m.metrics.find((i) => i.key === key);
    if (x) return x;
  }
  return null;
};

export function makeDashboard(b: Base, costs: Costs, inventory: Inventory, people: People, governance: Governance) {
  async function adoptionTotals(orgId: string) {
    const period = new Date().toISOString().slice(0, 7);
    let rows = await b.orgScope(orgId, (tx) => tx.select().from(aiAdoptionMetrics).where(and(eq(aiAdoptionMetrics.organizationId, orgId), eq(aiAdoptionMetrics.period, period))));
    if (!rows.length || rows.every((r) => Date.now() - r.computedAt.getTime() > 6 * 3600_000)) {
      await people.snapshotAdoption(orgId);
      rows = await b.orgScope(orgId, (tx) => tx.select().from(aiAdoptionMetrics).where(and(eq(aiAdoptionMetrics.organizationId, orgId), eq(aiAdoptionMetrics.period, period))));
    }
    const s = (k: "members" | "licensedUsers" | "activeUsers" | "aiRuns") => rows.reduce((a, r) => a + r[k], 0);
    return { members: s("members"), licensedUsers: s("licensedUsers"), activeUsers: s("activeUsers"), aiRuns: s("aiRuns"), byDepartment: new Map(rows.map((r) => [r.department, r.members])) };
  }

  async function valueSummary(orgId: string, insights: ModuleInsights[]) {
    const rows = await b.orgScope(orgId, (tx) => tx.select().from(aiValueRecords).where(eq(aiValueRecords.organizationId, orgId)));
    const realized = rows.filter((r) => r.kind === "realized").reduce((a, r) => a + r.annualValueUsd, 0);
    const projectedLedger = rows.filter((r) => r.kind === "projected").reduce((a, r) => a + r.annualValueUsd, 0);
    const wiProjected = metric(insights, "value.projected_annual_usd")?.value ?? 0;
    const reqProjected = Number(((await b.orgScope(orgId, (tx) => tx.execute(sql`select coalesce(sum(expected_annual_value), 0)::float8 as v from ai_requests where organization_id = ${orgId} and stage in ('approved','implementation','measurement')`))).rows[0] as { v: number }).v);
    return {
      realized: round2(realized), basisRealized: "measured" as const,
      projected: round2(projectedLedger + wiProjected + reqProjected), basisProjected: "estimated" as const,
      sources: [
        { label: "Measured value records (incl. Workflow Intelligence ROI measurements)", value: round2(realized), basis: "measured" as const },
        { label: "Workflow Intelligence: approved opportunities", value: round2(wiProjected), basis: "estimated" as const },
        { label: "Approved AI requests (expected value)", value: round2(reqProjected), basis: "estimated" as const },
        { label: "Projected value records", value: round2(projectedLedger), basis: "estimated" as const },
      ],
    };
  }

  async function unitEconomics(orgId: string, insights: ModuleInsights[]) {
    const to = addDays(today(), 1);
    const from30 = addDays(to, -30);
    const ls = await costs.lines(orgId, from30, to);
    const cost30 = sumBasis(ls);
    const adopt = await adoptionTotals(orgId);
    const byWorkflow = ls.filter((l) => l.workflowId);
    const byAgent = ls.filter((l) => l.agentId);
    const integration = ls.filter((l) => l.module === "integration_hub");
    const executions = metric(insights, "automation.executions_30d")?.value ?? null;
    const models = (await b.orgScope(orgId, (tx) => tx.execute(sql`select ai_provider, ai_model, sum(quantity)::float8 as runs from usage_events where organization_id = ${orgId} and metric = 'ai.runs' and occurred_at >= ${from30}::date group by 1, 2`))).rows as Array<{ ai_provider: string; ai_model: string; runs: number }>;
    const runs = models.reduce((a, r) => a + Number(r.runs), 0);
    const ttm = sumBasis(await costs.lines(orgId, `${Number(to.slice(0, 4)) - 1}${to.slice(4, 7)}-01`, to));
    const realized = Number(((await b.orgScope(orgId, (tx) => tx.execute(sql`select coalesce(sum(annual_value_usd), 0)::float8 as v from ai_value_records where organization_id = ${orgId} and kind = 'realized'`))).rows[0] as { v: number }).v);
    const deptCosts = new Map<string, CostByBasis>();
    for (const l of ls) deptCosts.set(l.department ?? "Unassigned", addCost(deptCosts.get(l.department ?? "Unassigned") ?? emptyCost(), { [l.basis]: l.amount }));
    return {
      window: { from: from30, to, note: "Last 30 days of cost; per-unit figures keep measured, estimated and allocated cost apart." },
      metrics: [
        unitMetric("per_active_user", "Cost per active user", "active user (30 days)", cost30, adopt.activeUsers || null, "People with AI activity or an active license in use in the last 30 days"),
        unitMetric("per_workflow", "Cost per workflow", "workflow with attributed AI cost", sumBasis(byWorkflow), new Set(byWorkflow.map((l) => l.workflowId)).size || null, "Workflows that AI usage was attributed to"),
        unitMetric("per_automated_task", "Cost per automated task", "successful live integration execution", sumBasis(integration), executions, "Integration module, successful live executions (30 days)"),
        unitMetric("per_agent", "Cost per agent", "agent with attributed AI cost", sumBasis(byAgent), new Set(byAgent.map((l) => l.agentId)).size || null, `Agents with attributed AI cost${metric(insights, "agents.total") ? ` (of ${metric(insights, "agents.total")!.value} registered)` : ""}`),
        unitMetric("per_ai_run", "Cost per AI run", "platform AI run", sumBasis(ls.filter((l) => l.source === "metered")), runs || null, "All platform AI runs (30 days)"),
        costPerValueDollar(ttm, realized),
      ],
      perModel: models.map((m) => {
        const c = sumBasis(ls.filter((l) => l.provider === m.ai_provider && l.model === m.ai_model));
        return unitMetric(`model:${m.ai_provider}/${m.ai_model}`, `${m.ai_provider}/${m.ai_model}`, "run", c, Number(m.runs), "Runs in the last 30 days");
      }).sort((a, c) => totalCost(c.cost) - totalCost(a.cost)).slice(0, 15),
      perDepartment: [...deptCosts.entries()].map(([d, c]) => unitMetric(`dept:${d}`, d, "member", c, adopt.byDepartment.get(d) ?? null, "Active members of the department")).sort((a, c) => totalCost(c.cost) - totalCost(a.cost)),
    };
  }

  return {
    unitEconomics,

    async unitEconomicsFor(ctx: TenantContext) {
      await b.require(ctx, "ai_ops.cost.read");
      return unitEconomics(b.org(ctx), await b.deps.insights.collect(ctx));
    },

    async dashboard(ctx: TenantContext) {
      await b.require(ctx, "ai_ops.read");
      const orgId = b.org(ctx);
      await governance.seed(orgId);
      if (!(await b.can(ctx, "ai_ops.cost.read"))) {
        // People without cost access get their own AI workspace, not the executive view.
        const [tools, training, requests, useCases] = [await inventory.listTools(ctx), await people.listAssignments(ctx, { mine: true }), await governance.listRequests(ctx, { mine: true }), await people.listUseCases(ctx)];
        return { mode: "personal" as const, approvedTools: tools.filter((t) => t.status === "strategic" || t.status === "approved"), training, requests, useCases };
      }
      const insights = await b.deps.insights.collect(ctx);
      const to = addDays(today(), 1);
      const from = `${Number(to.slice(0, 4)) - 1}${to.slice(4, 7)}-01`;
      const ls = await costs.lines(orgId, from, to);
      const st = await costs.settings(orgId);
      const [tools, vendors, licenseAct, findings, requests] = await b.orgScope(orgId, async (tx) => [
        await tx.select({ id: aiTools.id, status: aiTools.status, seats: aiTools.licensedSeats, securityReview: aiTools.securityReview, privacyReview: aiTools.privacyReview }).from(aiTools).where(eq(aiTools.organizationId, orgId)),
        await tx.select({ id: aiVendors.id, status: aiVendors.status, securityStatus: aiVendors.securityStatus }).from(aiVendors).where(eq(aiVendors.organizationId, orgId)),
        await inventory.licenseActivity(orgId, st.unusedLicenseDays),
        await tx.select({ status: aiOptimizationFindings.status, savings: aiOptimizationFindings.estimatedAnnualSavings, decidedBy: aiOptimizationFindings.decidedBy }).from(aiOptimizationFindings).where(eq(aiOptimizationFindings.organizationId, orgId)),
        await tx.select({ stage: aiRequests.stage }).from(aiRequests).where(eq(aiRequests.organizationId, orgId)),
      ] as const);
      const adopt = await adoptionTotals(orgId);
      const active = tools.filter((t) => t.status !== "retiring");
      const modelSpend = costs.group(ls.filter((l) => l.source === "metered"), "model").slice(0, 8);
      const g = (key: string) => metric(insights, key);
      const pendingStages = ["submitted", "business_review", "security_review", "technical_review", "financial_review"];
      const budgets = await costs.listBudgets(ctx).catch(() => []);
      return {
        mode: "executive" as const,
        spend: { from, to, ...rounded(sumBasis(ls)), href: `${BASE}/costs` },
        trend: costs.group(ls, "month"),
        byCategory: costs.group(ls, "category"),
        modelSpend: { rows: modelSpend, total: round2(modelSpend.reduce((a, r) => a + r.total, 0)), basis: "measured" as const, href: `${BASE}/models` },
        tools: { active: active.length, byStatus: ["strategic", "approved", "experimental", "restricted", "retiring"].map((s) => ({ label: s, value: tools.filter((t) => t.status === s).length })), href: `${BASE}/tools` },
        vendors: { active: vendors.filter((v) => v.status === "active").length, href: `${BASE}/vendors` },
        licenses: { seats: tools.reduce((a, t) => a + t.seats, 0), assigned: licenseAct.reduce((a, x) => a + x.active + x.unused, 0), active: licenseAct.reduce((a, x) => a + x.active, 0), unused: licenseAct.reduce((a, x) => a + x.unused, 0), windowDays: st.unusedLicenseDays, href: `${BASE}/tools` },
        adoption: { members: adopt.members, activeUsers: adopt.activeUsers, licensedUsers: adopt.licensedUsers, activePct: adopt.members ? Math.round((adopt.activeUsers / adopt.members) * 100) : 0, href: `${BASE}/adoption` },
        agents: { total: g("agents.total")?.value ?? null, highRisk: g("agents.high_risk")?.value ?? null, href: g("agents.total")?.href ?? null },
        value: await valueSummary(orgId, insights),
        savings: {
          projected: round2(findings.filter((f) => f.status === "open" || f.status === "accepted").reduce((a, f) => a + f.savings, 0)),
          actioned: round2(findings.filter((f) => f.status === "resolved" && f.decidedBy).reduce((a, f) => a + f.savings, 0)),
          openFindings: findings.filter((f) => f.status === "open").length, basis: "estimated" as const, href: `${BASE}/optimization`,
        },
        requests: { pending: requests.filter((r) => pendingStages.includes(r.stage)).length, inImplementation: requests.filter((r) => r.stage === "implementation").length, href: `${BASE}/requests` },
        governance: {
          toolsMissingSecurityReview: active.filter((t) => t.securityReview !== "approved" && t.securityReview !== "conditional").length,
          toolsMissingPrivacyReview: active.filter((t) => t.privacyReview !== "approved" && t.privacyReview !== "conditional").length,
          vendorsNotApproved: vendors.filter((v) => v.status === "active" && v.securityStatus !== "approved" && v.securityStatus !== "conditional").length,
          signals: insights.flatMap((m) => m.metrics.filter((x) => /^(security|dlp|shadow_ai|agents\.high_risk|agents\.unreviewed|incidents|knowledge\.low_confidence)/.test(x.key)).map((x) => ({ module: m.label, ...x }))),
        },
        budgets: budgets.map((x) => ({ id: x.id, name: x.name, periodLabel: x.periodLabel, amount: x.amount, spent: x.spent, pctSpent: x.pctSpent, projectedPct: x.projectedPct, status: x.status })),
        modules: insights,
        unitEconomics: await unitEconomics(orgId, insights),
      };
    },
  };
}

export type Dashboard = ReturnType<typeof makeDashboard>;
