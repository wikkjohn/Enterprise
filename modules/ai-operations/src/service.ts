import { z } from "zod";
import { and, eq, sql } from "@eaop/db";
import { type TenantContext } from "@eaop/shared-types";
import { makeBase, parse, type AiOpsDeps } from "./base";
import { makeCosts } from "./costs";
import { makeDashboard } from "./dashboard";
import { makeGovernance } from "./governance";
import { makeInventory } from "./inventory";
import { makePeople } from "./people";
import { aiOpsSettings, aiRequests, aiTools, aiVendors } from "./schema";

export { BASE, DAILY_JOB, MODULE_ID, type AiOpsDeps } from "./base";

const settingsSchema = z.object({
  fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
  renewalNoticeDays: z.number().int().min(7).max(365).optional(),
  unusedLicenseDays: z.number().int().min(7).max(365).optional(),
  costSpikePct: z.number().int().min(10).max(1000).optional(),
  contractUtilizationFloorPct: z.number().int().min(1).max(100).optional(),
  adoptionMinGroup: z.number().int().min(3).max(100).optional(),
});

/**
 * AI Operations Management: the system of record for the AI estate — tools,
 * vendors, contracts, costs, budgets, model policies, adoption, training,
 * requests, the Center of Excellence and business value — built entirely on
 * the shared core (usage metering, AI registry, RBAC, audit, notifications,
 * events, jobs, cross-module insights).
 */
export function createAiOpsService(deps: AiOpsDeps) {
  const b = makeBase(deps);
  const costs = makeCosts(b);
  const inventory = makeInventory(b, costs.settings);
  const people = makePeople(b, costs.settings);
  const governance = makeGovernance(b, costs, inventory);
  const dashboard = makeDashboard(b, costs, inventory, people, governance);

  const service = {
    ...inventory, ...costs, ...people, ...governance, ...dashboard,

    /** The starter library is created on first use, whichever page is opened first. */
    async listUseCases(ctx: TenantContext, q: { department?: string } = {}) {
      await b.require(ctx, "ai_ops.read");
      await governance.seed(b.org(ctx));
      return people.listUseCases(ctx, q);
    },

    async getSettings(ctx: TenantContext) {
      await b.require(ctx, "ai_ops.read");
      const s = await costs.settings(b.org(ctx));
      return { fiscalYearStartMonth: s.fiscalYearStartMonth, renewalNoticeDays: s.renewalNoticeDays, unusedLicenseDays: s.unusedLicenseDays, costSpikePct: s.costSpikePct, contractUtilizationFloorPct: s.contractUtilizationFloorPct, adoptionMinGroup: s.adoptionMinGroup };
    },
    async updateSettings(ctx: TenantContext, raw: unknown) {
      await b.require(ctx, "ai_ops.admin");
      const input = parse(settingsSchema, raw);
      const before = await costs.settings(b.org(ctx));
      await b.tenant(ctx, (tx) => tx.update(aiOpsSettings).set({ ...input, updatedBy: b.userId(ctx), updatedAt: new Date() }).where(eq(aiOpsSettings.organizationId, b.org(ctx))));
      await b.record(ctx, "ai_ops.settings_updated", "ai_ops_settings", b.org(ctx), { before: Object.fromEntries(Object.keys(input).map((k) => [k, (before as Record<string, unknown>)[k]])), after: input });
      return service.getSettings(ctx);
    },

    /** Daily job for one organization. Each step is independent; one failing does not stop the others. */
    async runDaily(orgId: string) {
      const out: Record<string, unknown> = {};
      const step = async (name: string, fn: () => Promise<unknown>) => {
        try {
          out[name] = await fn();
        } catch (e) {
          out[name] = "failed";
          deps.logger.warn("ai_ops.daily_step_failed", { step: name, error: e instanceof Error ? e.message : String(e) });
        }
      };
      await step("seed", () => governance.seed(orgId));
      await step("renewals", () => inventory.checkRenewals(orgId));
      await step("budgets", () => costs.checkBudgets(orgId));
      await step("training", () => people.expireTraining(orgId));
      await step("adoption", () => people.snapshotAdoption(orgId));
      await step("forecast", () => costs.refreshForecast(orgId));
      await step("optimization", () => governance.scan(orgId));
      return out;
    },
    async runDailyAll() {
      const orgs = await deps.db.withSystem("ai_ops.daily", (tx) => tx.execute(sql`select id from organizations where status = 'active'`));
      for (const r of orgs.rows as Array<{ id: string }>) if (await deps.modules.isEnabled(r.id, "ai_operations")) await service.runDaily(r.id);
    },

    /** Global search over tools, vendors and (for request managers) requests. */
    async search(ctx: TenantContext, q: string, limit: number) {
      const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      const out: Array<{ kind: "tool" | "vendor" | "request"; id: string; title: string; subtitle: string }> = [];
      await b.tenant(ctx, async (tx) => {
        for (const t of await tx.select({ id: aiTools.id, name: aiTools.name, status: aiTools.status, category: aiTools.category }).from(aiTools).where(and(eq(aiTools.organizationId, b.org(ctx)), sql`${aiTools.name} ilike ${like}`)).limit(limit)) out.push({ kind: "tool", id: t.id, title: t.name, subtitle: `AI tool · ${t.status} · ${t.category.replace(/_/g, " ")}` });
        for (const v of await tx.select({ id: aiVendors.id, name: aiVendors.name }).from(aiVendors).where(and(eq(aiVendors.organizationId, b.org(ctx)), sql`${aiVendors.name} ilike ${like}`)).limit(limit)) out.push({ kind: "vendor", id: v.id, title: v.name, subtitle: "AI vendor" });
      });
      if (await b.can(ctx, "ai_ops.request.manage")) {
        const rs = await b.tenant(ctx, (tx) => tx.select({ id: aiRequests.id, title: aiRequests.title, stage: aiRequests.stage }).from(aiRequests).where(and(eq(aiRequests.organizationId, b.org(ctx)), sql`${aiRequests.title} ilike ${like}`)).limit(limit));
        for (const r of rs) out.push({ kind: "request", id: r.id, title: r.title, subtitle: `AI request · ${r.stage.replace(/_/g, " ")}` });
      }
      return out.slice(0, limit);
    },
  };
  return service;
}

export type AiOpsService = ReturnType<typeof createAiOpsService>;
