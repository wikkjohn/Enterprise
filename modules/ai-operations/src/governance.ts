import { z } from "zod";
import { and, asc, desc, eq, inArray, sql } from "@eaop/db";
import { AppError, conflict, forbidden, notFound, type TenantContext } from "@eaop/shared-types";
import { BASE, iso, parse, text, today, usdAmount, type Base } from "./base";
import { type Costs } from "./costs";
import { type Inventory } from "./inventory";
import {
  abnormalUsage, costSpikes, duplicateTools, expensiveModels, FINDING_KINDS, idleTools, underutilizedContracts, unusedLicenses, type DailySeries, type Finding, type ModelPrice, type ModelUsage,
} from "./optimize";
import { applyPolicy, compliance, CLASSIFICATIONS, MODEL_TIERS, selectPolicy, type CandidateModel, type ModelPolicy, type RunGroup, type Tier } from "./policies";
import { isReviewStage, nextStage, progress, REQUEST_KINDS, REVIEW_DECISIONS, STAGE_LABEL, TransitionError, type RequestAction, type RequestStage } from "./requests";
import {
  aiCoeItems, aiImplementationTemplates, aiModelPolicies, aiOpsSettings, aiOptimizationFindings, aiRequestReviews, aiRequests, aiTools, aiUseCases, aiValueRecords, aiVendorContracts, CLASSIFICATION, TOOL_CATEGORIES,
} from "./schema";
import { TEMPLATE_SEEDS, USE_CASE_SEEDS } from "./seeds";

const requestSchema = z.object({
  kind: z.enum(REQUEST_KINDS), title: text(200).min(3), description: text(8000).default(""), businessJustification: text(8000).default(""), department: text(120).nullish(),
  dataClassification: z.enum(CLASSIFICATION).default("internal"), estimatedAnnualCost: usdAmount.default(0), expectedAnnualValue: usdAmount.default(0), vendorName: text(160).nullish(),
});
const policySchema = z.object({
  name: text(160).min(1), description: text(2000).default(""), priority: z.number().int().min(1).max(1000).default(100), enforcement: z.enum(["advisory", "enforced"]).default("advisory"), status: z.enum(["active", "disabled"]).default("active"),
  match: z.object({ useCases: z.array(text(120).regex(/^[a-z0-9_.*-]+$/i, "Use-case patterns use letters, digits, . _ - and *")).max(50).default([]), modules: z.array(text(60)).max(10).default([]), dataClassifications: z.array(z.enum(CLASSIFICATIONS)).max(4).default([]) }),
  rules: z.object({
    allowedTiers: z.array(z.enum(MODEL_TIERS)).max(3).default([]), preferredTier: z.enum(MODEL_TIERS).nullable().default(null), allowedModels: z.array(text(200)).max(50).default([]), blockedModels: z.array(text(200)).max(50).default([]),
    allowedProviders: z.array(text(120)).max(20).default([]), requiredCapabilities: z.array(text(60)).max(20).default([]), maxCostPerMtok: z.number().min(0).max(100_000).nullable().default(null), maxLatencyMs: z.number().int().min(50).max(600_000).nullable().default(null),
  }),
  regulatoryNote: text(2000).nullish(),
});
const valueSchema = z.object({
  kind: z.enum(["realized", "projected"]), annualValueUsd: z.number().finite().min(-1e10).max(1e10), title: text(200).min(1), description: text(4000).default(""), department: text(120).nullish(),
  toolId: z.string().uuid().nullish(), useCaseId: z.string().uuid().nullish(), requestId: z.string().uuid().nullish(),
});
const coeSchema = z.object({ kind: z.enum(["standard", "policy", "guidance", "best_practice"]), title: text(200).min(1), body: text(50_000).default(""), ownerUserId: z.string().uuid().nullish(), status: z.enum(["draft", "published", "retired"]).default("draft"), reviewDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish() });
const templateSchema = z.object({
  name: text(200).min(1), category: text(60).default("other"), businessObjective: text(4000).default(""), systems: z.array(text(200)).max(30).default([]), data: text(4000).default(""), aiCapability: text(4000).default(""),
  riskLevel: z.enum(["low", "medium", "high"]).default("medium"), risks: text(4000).default(""), implementation: z.array(text(1000)).max(30).default([]), measurement: z.array(text(500)).max(30).default([]),
  workflowRefs: z.array(text(120)).max(20).default([]), status: z.enum(["draft", "published", "retired"]).default("draft"),
});

type RequestRow = typeof aiRequests.$inferSelect;

export function makeGovernance(b: Base, costs: Costs, inventory: Inventory) {
  const { deps } = b;

  // ── Model policies (cached for the routing hook) ─────────────────────────
  const policyCache = new Map<string, { at: number; policies: ModelPolicy[] }>();
  const latencyCache = new Map<string, { at: number; byModel: Map<string, number> }>();
  async function policiesFor(orgId: string): Promise<ModelPolicy[]> {
    const hit = policyCache.get(orgId);
    if (hit && Date.now() - hit.at < 30_000) return hit.policies;
    const rows = await b.orgScope(orgId, (tx) => tx.select().from(aiModelPolicies).where(and(eq(aiModelPolicies.organizationId, orgId), eq(aiModelPolicies.status, "active"))));
    const policies = rows.map((r) => ({ id: r.id, name: r.name, priority: r.priority, enforcement: r.enforcement, status: r.status, match: r.match, rules: r.rules, regulatoryNote: r.regulatoryNote }));
    policyCache.set(orgId, { at: Date.now(), policies });
    return policies;
  }
  async function medianLatency(orgId: string) {
    const hit = latencyCache.get(orgId);
    if (hit && Date.now() - hit.at < 300_000) return hit.byModel;
    const rows = (await b.orgScope(orgId, (tx) => tx.execute(sql`select provider_key, model_key, percentile_cont(0.5) within group (order by latency_ms)::int as p50 from ai_runs where organization_id = ${orgId} and status = 'succeeded' and created_at >= now() - interval '7 days' group by 1, 2`))).rows as Array<{ provider_key: string; model_key: string; p50: number }>;
    const byModel = new Map(rows.map((r) => [`${r.provider_key}/${r.model_key}`, r.p50]));
    latencyCache.set(orgId, { at: Date.now(), byModel });
    return byModel;
  }

  /** Routing hook registered with the shared AI layer. Advisory policies never change routing. */
  async function route<C extends CandidateModel>(candidates: C[], req: { organizationId: string; moduleId: string; useCase: string; dataClassification: string }): Promise<C[]> {
    if (!(await deps.modules.isEnabled(req.organizationId, "ai_operations"))) return candidates;
    const p = selectPolicy(await policiesFor(req.organizationId), req);
    if (!p || p.enforcement !== "enforced") return candidates;
    const lat = p.rules.maxLatencyMs != null ? await medianLatency(req.organizationId) : null;
    const { allowed, excluded } = applyPolicy(p, candidates, (c) => lat?.get(`${c.providerKey}/${c.modelKey}`) ?? null);
    if (!allowed.length) deps.logger.warn("ai_ops.routing_policy_no_model", { organizationId: req.organizationId, policy: p.name, useCase: req.useCase, excluded: excluded.length });
    return allowed;
  }

  async function catalog(orgId: string) {
    const rows = (await b.orgScope(orgId, (tx) => tx.execute(sql`
      select p.key as provider_key, p.kind, m.model_key, m.display_name, m.tier, m.capabilities, m.input_cost_per_mtok::float8 as input_cost, m.output_cost_per_mtok::float8 as output_cost, m.max_data_classification, m.status, m.organization_id
      from ai_models m join ai_providers p on p.id = m.provider_id
      where (m.organization_id is null or m.organization_id = ${orgId}) and (p.organization_id is null or p.organization_id = ${orgId}) and m.status = 'active' and p.status = 'enabled'`))).rows as Array<Record<string, unknown>>;
    return rows.map((r) => ({ providerKey: String(r.provider_key), providerKind: String(r.kind), modelKey: String(r.model_key), displayName: String(r.display_name), tier: r.tier as Tier, capabilities: (r.capabilities as string[]) ?? [], inputCostPerMtok: Number(r.input_cost), outputCostPerMtok: Number(r.output_cost), maxDataClassification: String(r.max_data_classification) }));
  }

  async function runGroups(orgId: string, days: number): Promise<RunGroup[]> {
    const rows = (await b.orgScope(orgId, (tx) => tx.execute(sql`
      select r.use_case, r.module_id, r.provider_key, r.model_key, coalesce(r.metadata->>'dataClassification', 'internal') as cls, count(*)::int as runs, sum(r.estimated_cost_usd)::float8 as cost,
        sum(r.input_tokens)::float8 as input_tokens, sum(r.output_tokens)::float8 as output_tokens, percentile_cont(0.5) within group (order by r.latency_ms)::int as p50,
        max(m.tier) as tier, max(m.input_cost_per_mtok)::float8 as in_cost, max(m.output_cost_per_mtok)::float8 as out_cost, (array_agg(m.capabilities))[1] as capabilities
      from ai_runs r left join ai_providers p on p.key = r.provider_key and (p.organization_id is null or p.organization_id = r.organization_id)
        left join ai_models m on m.provider_id = p.id and m.model_key = r.model_key
      where r.organization_id = ${orgId} and r.status = 'succeeded' and r.created_at >= now() - make_interval(days => ${days})
      group by 1, 2, 3, 4, 5`))).rows as Array<Record<string, unknown>>;
    return rows.map((r) => ({ useCase: String(r.use_case), moduleId: String(r.module_id), dataClassification: String(r.cls), provider: String(r.provider_key), model: String(r.model_key), tier: ((r.tier as string) ?? "standard") as Tier, capabilities: (r.capabilities as string[]) ?? [], inputCostPerMtok: Number(r.in_cost ?? 0), outputCostPerMtok: Number(r.out_cost ?? 0), runs: Number(r.runs), cost: Number(r.cost ?? 0), inputTokens: Number(r.input_tokens ?? 0), outputTokens: Number(r.output_tokens ?? 0), medianLatencyMs: r.p50 == null ? null : Number(r.p50) }));
  }

  // ── Optimization scan ────────────────────────────────────────────────────
  async function scan(orgId: string, now = new Date()) {
    const st = await costs.settings(orgId);
    const ctx = b.sysCtx(orgId);
    const tools = await b.orgScope(orgId, (tx) => tx.select().from(aiTools).where(eq(aiTools.organizationId, orgId)));
    const tForOpt = tools.map((t) => ({ id: t.id, name: t.name, category: t.category, status: t.status, departments: t.departments, annualCost: t.annualCost, licensedSeats: t.licensedSeats, vendorId: t.vendorId }));
    const activity = await inventory.licenseActivity(orgId, st.unusedLicenseDays);
    const idleWindow = Math.max(60, st.unusedLicenseDays);
    const idleActivity = await inventory.licenseActivity(orgId, idleWindow);
    const groups = await runGroups(orgId, 30);
    const cat = await catalog(orgId);
    const usage: ModelUsage[] = [...groups.reduce((m, g) => {
      const k = `${g.moduleId}|${g.useCase}|${g.provider}|${g.model}`;
      const cur = m.get(k);
      const rank = (c: string) => CLASSIFICATIONS.indexOf(c as (typeof CLASSIFICATIONS)[number]);
      m.set(k, cur ? { ...cur, runs: cur.runs + g.runs, cost: cur.cost + g.cost, inputTokens: cur.inputTokens + g.inputTokens, outputTokens: cur.outputTokens + g.outputTokens, dataClassification: rank(g.dataClassification) > rank(cur.dataClassification) ? g.dataClassification : cur.dataClassification }
        : { useCase: g.useCase, moduleId: g.moduleId, provider: g.provider, model: g.model, tier: g.tier, dataClassification: g.dataClassification, runs: g.runs, cost: g.cost, inputTokens: g.inputTokens, outputTokens: g.outputTokens, days: 30 });
      return m;
    }, new Map<string, ModelUsage>()).values()];
    // Never recommend the simulated sandbox model as an alternative.
    const prices: ModelPrice[] = cat.filter((c) => c.providerKind !== "sandbox").map((c) => ({ provider: c.providerKey, model: c.modelKey, tier: c.tier, inputCostPerMtok: c.inputCostPerMtok, outputCostPerMtok: c.outputCostPerMtok, maxDataClassification: c.maxDataClassification }));
    const tokenSeries = (await b.orgScope(orgId, (tx) => tx.execute(sql`
      select module_id, to_char(date_trunc('day', occurred_at), 'YYYY-MM-DD') as day, sum(quantity)::float8 as v from usage_events
      where organization_id = ${orgId} and metric in ('ai.input_tokens','ai.output_tokens') and occurred_at >= now() - interval '22 days' group by 1, 2`))).rows as Array<{ module_id: string; day: string; v: number }>;
    const series = (rows: Array<{ k: string; day: string; v: number }>, label: (k: string) => string): DailySeries[] => {
      const keys = [...new Set(rows.map((r) => r.k))];
      const days: string[] = [];
      for (let i = 21; i >= 1; i--) days.push(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10));
      return keys.map((k) => ({ key: k, label: label(k), values: days.map((d) => ({ day: d, value: rows.filter((r) => r.k === k && r.day === d).reduce((a, r) => a + r.v, 0) })) }));
    };
    const from = new Date(now.getTime() - 36 * 86_400_000).toISOString().slice(0, 10);
    const spendDaily = (await b.orgScope(orgId, (tx) => tx.execute(sql`select to_char(date_trunc('day', occurred_at), 'YYYY-MM-DD') as day, sum(quantity)::float8 as v from usage_events where organization_id = ${orgId} and metric = 'ai.cost' and occurred_at >= ${from}::date and occurred_at < ${today(now)}::date group by 1`))).rows as Array<{ day: string; v: number }>;
    const spendDays: string[] = [];
    for (let i = 35; i >= 1; i--) spendDays.push(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10));
    const contracts = await b.orgScope(orgId, (tx) => tx.select().from(aiVendorContracts).where(and(eq(aiVendorContracts.organizationId, orgId), eq(aiVendorContracts.status, "active"), sql`${aiVendorContracts.committedAnnualSpend} > 0`)));
    const ninety = new Date(now.getTime() - 90 * 86_400_000).toISOString().slice(0, 10);
    const contractLines = contracts.length ? await costs.lines(orgId, ninety, today(now)) : [];
    const vendors = (await b.orgScope(orgId, (tx) => tx.execute(sql`select id, platform_provider_keys from ai_vendors where organization_id = ${orgId}`))).rows as Array<{ id: string; platform_provider_keys: string[] }>;

    const found: Finding[] = [
      ...unusedLicenses(tForOpt, activity, st.unusedLicenseDays),
      ...idleTools(tForOpt, idleActivity, idleWindow),
      ...duplicateTools(tForOpt),
      ...expensiveModels(usage, prices, { maxAvgInput: 2000, maxAvgOutput: 400, minRuns: 50 }),
      ...abnormalUsage(series(tokenSeries.map((r) => ({ k: r.module_id, day: r.day, v: r.v })), (k) => `the ${k.replace(/_/g, " ")} module`), { baselineDays: 14, z: 3, minRatio: 3, minValue: 50_000, unit: "tokens" }),
      ...costSpikes([{ key: "platform_ai", label: "Platform AI", values: spendDays.map((d) => ({ day: d, value: spendDaily.find((r) => r.day === d)?.v ?? 0 })) }], { thresholdPct: st.costSpikePct, minWeekly: 50 }),
      ...underutilizedContracts(contracts.map((c) => {
        const keys = vendors.find((v) => v.id === c.vendorId)?.platform_provider_keys ?? [];
        const spent = contractLines.filter((l) => l.contractId === c.id && l.basis !== "estimated" || (l.source === "metered" && l.provider && keys.includes(l.provider))).reduce((a, l) => a + l.amount, 0);
        return { id: c.id, name: c.name, vendorId: c.vendorId, committedAnnual: c.committedAnnualSpend, actualAnnualized: (spent * 365) / 90, renewalDate: c.renewalDate };
      }), st.contractUtilizationFloorPct),
    ];
    const res = await b.orgScope(orgId, async (tx) => {
      const created: Array<{ id: string; kind: string; savings: number }> = [];
      for (const f of found) {
        const [row] = await tx.insert(aiOptimizationFindings).values({ organizationId: orgId, kind: f.kind, dedupeKey: f.dedupeKey, title: f.title, detail: f.detail, recommendation: f.recommendation, severity: f.severity, estimatedAnnualSavings: f.estimatedAnnualSavings, toolId: f.toolId ?? null, vendorId: f.vendorId ?? null, contractId: f.contractId ?? null, modelKey: f.modelKey ?? null, evidence: f.evidence })
          .onConflictDoUpdate({ target: [aiOptimizationFindings.organizationId, aiOptimizationFindings.dedupeKey], set: { title: f.title, detail: f.detail, severity: f.severity, estimatedAnnualSavings: f.estimatedAnnualSavings, evidence: f.evidence, lastSeenAt: new Date(), status: sql`case when ${aiOptimizationFindings.status} = 'resolved' then 'open' else ${aiOptimizationFindings.status} end` } })
          .returning({ id: aiOptimizationFindings.id, firstSeen: aiOptimizationFindings.firstSeenAt, lastSeen: aiOptimizationFindings.lastSeenAt });
        if (row && row.firstSeen.getTime() === row.lastSeen.getTime()) created.push({ id: row.id, kind: f.kind, savings: f.estimatedAnnualSavings });
      }
      // Snapshot findings no longer detected are resolved automatically (anomalies keep their history).
      const keys = found.map((f) => f.dedupeKey);
      const resolved = await tx.update(aiOptimizationFindings).set({ status: "resolved", note: "No longer detected by the latest scan." })
        .where(and(eq(aiOptimizationFindings.organizationId, orgId), inArray(aiOptimizationFindings.status, ["open", "accepted"]), inArray(aiOptimizationFindings.kind, ["unused_licenses", "idle_tool", "duplicate_tools", "expensive_model", "underutilized_contract"]), keys.length ? sql`${aiOptimizationFindings.dedupeKey} <> all(${`{${keys.map((k) => `"${k.replace(/["\\]/g, "")}"`).join(",")}}`}::text[])` : undefined))
        .returning({ id: aiOptimizationFindings.id });
      return { created, resolved: resolved.length };
    });
    for (const c of res.created) await deps.bus.publish(ctx, "ai_ops.optimization.found", { findingId: c.id, kind: c.kind, estimatedAnnualSavings: c.savings });
    if (res.created.length) {
      const total = res.created.reduce((a, c) => a + c.savings, 0);
      await deps.notifications.notify(ctx, { type: "ai_ops.optimization", title: `${res.created.length} new AI cost optimization finding${res.created.length === 1 ? "" : "s"}`, body: `Estimated annual savings $${Math.round(total).toLocaleString("en-US")}. Recommendations only — nothing is changed automatically.`, actionUrl: `${BASE}/optimization`, recipients: { permission: "ai_ops.cost.manage" } });
    }
    return { found: found.length, created: res.created.length, resolved: res.resolved };
  }

  // ── Requests ─────────────────────────────────────────────────────────────
  async function requestView(ctx: TenantContext, rows: RequestRow[]) {
    const ids = [...new Set(rows.flatMap((r) => [r.requesterUserId, r.assigneeUserId]).filter((x): x is string => !!x))];
    const names = ids.length ? new Map(((await b.tenant(ctx, (tx) => tx.execute(sql`select id, name from users where id = any(${`{${ids.join(",")}}`}::uuid[])`))).rows as Array<{ id: string; name: string }>).map((r) => [r.id, r.name])) : new Map<string, string>();
    return rows.map((r) => ({ ...r, requester: r.requesterUserId ? names.get(r.requesterUserId) ?? null : null, assignee: r.assigneeUserId ? names.get(r.assigneeUserId) ?? null : null, stageLabel: STAGE_LABEL[r.stage], submittedAt: r.submittedAt.toISOString(), decidedAt: iso(r.decidedAt), createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() }));
  }
  async function loadRequest(ctx: TenantContext, id: string) {
    b.uuidOr404(id, "Request");
    const [r] = await b.tenant(ctx, (tx) => tx.select().from(aiRequests).where(and(eq(aiRequests.organizationId, b.org(ctx)), eq(aiRequests.id, id))).limit(1));
    if (!r) throw notFound("Request", id);
    const manage = await b.can(ctx, "ai_ops.request.manage");
    if (!manage && r.requesterUserId !== b.userId(ctx)) throw notFound("Request", id);
    return { r, manage };
  }

  // ── Seeding ──────────────────────────────────────────────────────────────
  async function seed(orgId: string) {
    const st = await costs.settings(orgId);
    if (st.seededAt) return false;
    await b.orgScope(orgId, async (tx) => {
      const tmplIds = new Map<string, string>();
      for (const t of TEMPLATE_SEEDS) {
        const [row] = await tx.insert(aiImplementationTemplates).values({ organizationId: orgId, key: t.key, name: t.name, category: t.category, businessObjective: t.businessObjective, systems: t.systems, data: t.data, aiCapability: t.aiCapability, riskLevel: t.riskLevel, risks: t.risks, implementation: t.implementation, measurement: t.measurement, status: "draft" }).onConflictDoNothing().returning({ id: aiImplementationTemplates.id });
        if (row) tmplIds.set(t.key, row.id);
      }
      for (const u of USE_CASE_SEEDS) {
        await tx.insert(aiUseCases).values({ organizationId: orgId, department: u.department, title: u.title, businessProblem: u.businessProblem, approvedWorkflow: u.approvedWorkflow, instructions: u.instructions, expectedBenefit: u.expectedBenefit, risks: u.risks, successMetric: u.successMetric, templateId: u.templateKey ? tmplIds.get(u.templateKey) ?? null : null, status: "draft" }).onConflictDoNothing();
      }
      await tx.update(aiOpsSettings).set({ seededAt: new Date() }).where(eq(aiOpsSettings.organizationId, orgId));
    });
    return true;
  }

  const findingView = (f: typeof aiOptimizationFindings.$inferSelect) => ({ ...f, firstSeenAt: f.firstSeenAt.toISOString(), lastSeenAt: f.lastSeenAt.toISOString(), basis: "estimated" as const });

  return {
    route, policiesFor, scan, seed, catalog,
    invalidatePolicies: (orgId: string) => policyCache.delete(orgId),

    // Requests
    async listRequests(ctx: TenantContext, q: { stage?: string; mine?: boolean } = {}) {
      await b.require(ctx, "ai_ops.read");
      const all = !q.mine && (await b.can(ctx, "ai_ops.request.manage"));
      const uid = b.userId(ctx);
      if (!all && !uid) return [];
      const rows = await b.tenant(ctx, (tx) => tx.select().from(aiRequests).where(and(eq(aiRequests.organizationId, b.org(ctx)), all ? undefined : eq(aiRequests.requesterUserId, uid!), q.stage === "open" ? sql`${aiRequests.stage} not in ('rejected','closed')` : q.stage ? eq(aiRequests.stage, q.stage as RequestStage) : undefined)).orderBy(desc(aiRequests.updatedAt)).limit(1000));
      return requestView(ctx, rows);
    },
    async getRequest(ctx: TenantContext, id: string) {
      await b.require(ctx, "ai_ops.read");
      const { r, manage } = await loadRequest(ctx, id);
      const history = await b.tenant(ctx, (tx) => tx.select().from(aiRequestReviews).where(eq(aiRequestReviews.requestId, id)).orderBy(asc(aiRequestReviews.createdAt)));
      const [view] = await requestView(ctx, [r]);
      const mine = r.requesterUserId === b.userId(ctx);
      return {
        ...view!, progress: progress(r.stage), history: history.map((h) => ({ ...h, createdAt: h.createdAt.toISOString() })),
        can: {
          review: manage && !mine && isReviewStage(r.stage), startReview: manage && !mine && r.stage === "submitted" && !r.changesRequested, implement: manage && r.stage === "approved", measure: manage && r.stage === "implementation",
          close: manage && ["approved", "implementation", "measurement", "rejected"].includes(r.stage), withdraw: mine && (r.stage === "submitted" || isReviewStage(r.stage)), edit: mine && r.stage === "submitted",
        },
      };
    },
    async submitRequest(ctx: TenantContext, raw: unknown) {
      await b.require(ctx, "ai_ops.read");
      if (ctx.actor.type !== "user") throw forbidden("Requests are submitted by people.");
      const input = parse(requestSchema, raw);
      const dept = input.department ?? (((await b.tenant(ctx, (tx) => tx.execute(sql`select department from memberships where organization_id = ${b.org(ctx)} and user_id = ${ctx.actor.id} limit 1`))).rows[0] as { department: string | null } | undefined)?.department ?? null);
      const row = await b.tenant(ctx, async (tx) => {
        const [r] = await tx.insert(aiRequests).values({ ...input, department: dept, organizationId: b.org(ctx), requesterUserId: ctx.actor.id }).returning();
        await tx.insert(aiRequestReviews).values({ organizationId: b.org(ctx), requestId: r!.id, stage: "submitted", action: "submit", fromStage: "submitted", toStage: "submitted", reviewerUserId: ctx.actor.id, actorLabel: ctx.actor.label });
        return r!;
      });
      await deps.bus.publish(ctx, "ai_ops.request.submitted", { requestId: row.id, kind: row.kind });
      await deps.notifications.notify(ctx, { type: "ai_ops.request", title: `New AI ${row.kind.replace("_", " ")} request: ${row.title}`, body: input.businessJustification.slice(0, 280), actionUrl: `${BASE}/requests/${row.id}`, recipients: { permission: "ai_ops.request.manage" } });
      await b.record(ctx, "ai_ops.request_submitted", "ai_request", row.id, { after: { kind: row.kind, title: row.title, estimatedAnnualCost: row.estimatedAnnualCost } });
      return (await requestView(ctx, [row]))[0]!;
    },
    async updateRequest(ctx: TenantContext, id: string, raw: unknown) {
      await b.require(ctx, "ai_ops.read");
      const { r } = await loadRequest(ctx, id);
      if (r.requesterUserId !== b.userId(ctx) || r.stage !== "submitted") throw conflict("Only the requester can edit, and only while the request is submitted.");
      const input = parse(requestSchema.partial(), raw);
      const [u] = await b.tenant(ctx, (tx) => tx.update(aiRequests).set({ ...input, updatedAt: new Date() }).where(eq(aiRequests.id, id)).returning());
      await b.record(ctx, "ai_ops.request_edited", "ai_request", id, { after: input });
      return (await requestView(ctx, [u!]))[0]!;
    },
    /** Move a request through the workflow. Reviews require ai_ops.request.manage and are never done by the requester. */
    async actOnRequest(ctx: TenantContext, id: string, raw: unknown) {
      await b.require(ctx, "ai_ops.read");
      const input = parse(z.object({
        action: z.enum(["start_review", "review", "start_implementation", "start_measurement", "close", "withdraw", "resubmit"]), decision: z.enum(REVIEW_DECISIONS).optional(), notes: text(4000).default(""),
        assigneeUserId: z.string().uuid().nullish(), outcome: text(4000).optional(), realizedAnnualValue: usdAmount.optional(), createTool: z.boolean().default(true),
      }), raw);
      const { r, manage } = await loadRequest(ctx, id);
      const mine = r.requesterUserId === b.userId(ctx);
      const requesterAction = input.action === "withdraw" || input.action === "resubmit";
      if (requesterAction && !mine) throw forbidden("Only the requester can withdraw or resubmit a request.");
      if (!requesterAction) {
        if (!manage) throw forbidden("Reviewing requests needs ai_ops.request.manage.");
        if (mine) throw forbidden("You cannot review or advance your own request.");
      }
      if (input.action === "review" && !input.decision) throw new AppError("VALIDATION_FAILED", "decision is required for a review.");
      if (input.action === "review" && input.decision !== "approve" && !input.notes.trim()) throw new AppError("VALIDATION_FAILED", "Explain the decision in notes.");
      const action = (input.action === "review" ? { type: "review", decision: input.decision! } : { type: input.action }) as RequestAction;
      let to: RequestStage;
      try {
        to = nextStage(r.stage, action, { changesRequested: r.changesRequested });
      } catch (e) {
        if (e instanceof TransitionError) throw conflict(e.message);
        throw e;
      }
      let toolId = r.toolId;
      if (input.action === "start_implementation" && r.kind === "tool" && !r.toolId && input.createTool) {
        const name = r.vendorName ? `${r.title}`.slice(0, 160) : r.title.slice(0, 160);
        const tool = await inventory.createTool(ctx, inventory.toolSchema.parse({ name, purpose: r.businessJustification || r.description, status: "experimental", departments: r.department ? [r.department] : [], annualCost: r.estimatedAnnualCost, maxDataClassification: r.dataClassification }), { source: "request", requestId: r.id }).catch((e: unknown) => {
          if (e instanceof AppError && e.code === "CONFLICT") return null;
          throw e;
        });
        toolId = tool?.id ?? null;
      }
      const updated = await b.tenant(ctx, async (tx) => {
        const [u] = await tx.update(aiRequests).set({
          stage: to, changesRequested: input.action === "review" && input.decision === "request_changes" ? true : input.action === "resubmit" ? false : r.changesRequested,
          ...(input.assigneeUserId !== undefined ? { assigneeUserId: input.assigneeUserId } : {}), ...(to === "approved" || to === "rejected" ? { decidedAt: new Date() } : {}),
          ...(input.outcome ? { outcome: input.outcome } : {}), ...(input.action === "withdraw" ? { closedReason: "withdrawn" } : to === "closed" ? { closedReason: r.stage === "rejected" ? "rejected" : "completed" } : {}),
          toolId, updatedAt: new Date(),
        }).where(and(eq(aiRequests.id, id), eq(aiRequests.stage, r.stage))).returning();
        if (!u) throw conflict("The request changed while you were working on it; reload and try again.");
        await tx.insert(aiRequestReviews).values({ organizationId: b.org(ctx), requestId: id, stage: r.stage, action: input.action, decision: input.decision ?? null, fromStage: r.stage, toStage: to, reviewerUserId: b.userId(ctx), actorLabel: ctx.actor.label, notes: input.notes });
        if (input.realizedAnnualValue != null && (to === "closed" || input.action === "start_measurement")) {
          await tx.insert(aiValueRecords).values({ organizationId: b.org(ctx), kind: "realized", basis: "measured", annualValueUsd: input.realizedAnnualValue!, title: `Measured value: ${r.title}`.slice(0, 200), description: input.outcome ?? "", sourceModule: "ai_operations", sourceRef: `request:${id}`, department: r.department, toolId, requestId: id, createdBy: b.userId(ctx) })
            .onConflictDoUpdate({ target: [aiValueRecords.organizationId, aiValueRecords.sourceModule, aiValueRecords.sourceRef], set: { annualValueUsd: input.realizedAnnualValue!, description: input.outcome ?? "", recordedAt: new Date() } });
        }
        return u;
      });
      if (to === "approved") await deps.bus.publish(ctx, "ai_ops.request.approved", { requestId: id, kind: r.kind });
      if (r.requesterUserId && r.requesterUserId !== b.userId(ctx) && (to === "approved" || to === "rejected" || (input.action === "review" && input.decision === "request_changes"))) {
        await deps.notifications.notify(ctx, { type: "ai_ops.request", title: `Your AI request "${r.title}" was ${to === "approved" ? "approved" : to === "rejected" ? "rejected" : "returned for changes"}`, body: input.notes.slice(0, 300), actionUrl: `${BASE}/requests/${id}`, priority: "normal", recipients: { userIds: [r.requesterUserId] } });
      }
      if (input.action === "resubmit") await deps.notifications.notify(ctx, { type: "ai_ops.request", title: `AI request resubmitted: ${r.title}`, body: input.notes.slice(0, 280), actionUrl: `${BASE}/requests/${id}`, recipients: { permission: "ai_ops.request.manage" } });
      await b.record(ctx, `ai_ops.request_${input.action}`, "ai_request", id, { before: { stage: r.stage }, after: { stage: to, decision: input.decision ?? null } });
      return (await requestView(ctx, [updated]))[0]!;
    },

    // Model policies
    async listPolicies(ctx: TenantContext) {
      await b.requireAny(ctx, ["ai_ops.cost.read", "ai_ops.admin"]);
      const rows = await b.tenant(ctx, (tx) => tx.select().from(aiModelPolicies).where(eq(aiModelPolicies.organizationId, b.org(ctx))).orderBy(asc(aiModelPolicies.priority), asc(aiModelPolicies.name)));
      const cat = await catalog(b.org(ctx));
      return rows.map((r) => {
        const p = { id: r.id, name: r.name, priority: r.priority, enforcement: r.enforcement, status: r.status, match: r.match, rules: r.rules };
        return { ...r, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), allowedModels: applyPolicy(p, cat).allowed.map((c) => `${c.providerKey}/${c.modelKey}`) };
      });
    },
    async savePolicy(ctx: TenantContext, id: string | null, raw: unknown) {
      await b.require(ctx, "ai_ops.admin");
      const input = parse(id ? policySchema.partial() : policySchema, raw);
      const row = await b.tenant(ctx, async (tx) => {
        if (!id) {
          const [dup] = await tx.select({ id: aiModelPolicies.id }).from(aiModelPolicies).where(and(eq(aiModelPolicies.organizationId, b.org(ctx)), eq(aiModelPolicies.name, input.name!))).limit(1);
          if (dup) throw conflict(`A policy named "${input.name}" already exists.`);
          return (await tx.insert(aiModelPolicies).values({ ...(input as z.output<typeof policySchema>), organizationId: b.org(ctx), createdBy: b.userId(ctx) }).returning())[0]!;
        }
        b.uuidOr404(id, "Policy");
        const [before] = await tx.select().from(aiModelPolicies).where(and(eq(aiModelPolicies.organizationId, b.org(ctx)), eq(aiModelPolicies.id, id))).limit(1);
        if (!before) throw notFound("Policy", id);
        const [u] = await tx.update(aiModelPolicies).set({ ...input, ...(input.match ? { match: { ...before.match, ...input.match } } : {}), ...(input.rules ? { rules: { ...before.rules, ...input.rules } } : {}), updatedAt: new Date() }).where(eq(aiModelPolicies.id, id)).returning();
        return u!;
      });
      policyCache.delete(b.org(ctx));
      const cat = await catalog(b.org(ctx));
      const allowed = applyPolicy({ id: row.id, name: row.name, priority: row.priority, enforcement: row.enforcement, status: row.status, match: row.match, rules: row.rules }, cat).allowed;
      await b.record(ctx, id ? "ai_ops.model_policy_updated" : "ai_ops.model_policy_created", "ai_model_policy", row.id, { after: { ...input, allowedModels: allowed.length } });
      return { id: row.id, name: row.name, enforcement: row.enforcement, allowedModels: allowed.map((c) => `${c.providerKey}/${c.modelKey}`), warning: row.enforcement === "enforced" && row.status === "active" && !allowed.length ? "No enabled model satisfies this policy: matching AI requests will fail until a model qualifies." : null };
    },
    async modelReport(ctx: TenantContext) {
      await b.require(ctx, "ai_ops.cost.read");
      const groups = await runGroups(b.org(ctx), 30);
      const cat = await catalog(b.org(ctx));
      const policies = (await b.tenant(ctx, (tx) => tx.select().from(aiModelPolicies).where(eq(aiModelPolicies.organizationId, b.org(ctx))))).map((r) => ({ id: r.id, name: r.name, priority: r.priority, enforcement: r.enforcement, status: r.status, match: r.match, rules: r.rules }));
      const byModel = new Map<string, { model: string; tier: string; runs: number; cost: number; inputTokens: number; outputTokens: number; p50: number | null }>();
      for (const g of groups) {
        const k = `${g.provider}/${g.model}`;
        const cur = byModel.get(k) ?? { model: k, tier: g.tier, runs: 0, cost: 0, inputTokens: 0, outputTokens: 0, p50: g.medianLatencyMs };
        byModel.set(k, { ...cur, runs: cur.runs + g.runs, cost: cur.cost + g.cost, inputTokens: cur.inputTokens + g.inputTokens, outputTokens: cur.outputTokens + g.outputTokens });
      }
      const useCases = new Map<string, { useCase: string; moduleId: string; runs: number; cost: number; models: Set<string>; policy: string | null }>();
      for (const g of groups) {
        const k = `${g.moduleId}|${g.useCase}`;
        const cur = useCases.get(k) ?? { useCase: g.useCase, moduleId: g.moduleId, runs: 0, cost: 0, models: new Set<string>(), policy: selectPolicy(policies.filter((p) => p.status === "active"), g)?.name ?? null };
        cur.runs += g.runs;
        cur.cost += g.cost;
        cur.models.add(`${g.provider}/${g.model}`);
        useCases.set(k, cur);
      }
      return {
        days: 30, basis: "measured" as const,
        models: [...byModel.values()].map((m) => ({ ...m, cost: Math.round(m.cost * 100) / 100, costPerRun: m.runs ? Math.round((m.cost / m.runs) * 10000) / 10000 : 0 })).sort((a, b2) => b2.cost - a.cost),
        useCases: [...useCases.values()].map((u) => ({ ...u, cost: Math.round(u.cost * 100) / 100, models: [...u.models] })).sort((a, b2) => b2.cost - a.cost).slice(0, 100),
        // Savings are priced against real models only (never the simulated sandbox).
        compliance: compliance(policies.filter((p) => p.status === "active"), groups, cat.filter((c) => c.providerKind !== "sandbox")),
        catalog: cat,
      };
    },

    // Optimization findings
    async listFindings(ctx: TenantContext, q: { status?: string } = {}) {
      await b.require(ctx, "ai_ops.cost.read");
      const rows = await b.tenant(ctx, (tx) => tx.select().from(aiOptimizationFindings).where(and(eq(aiOptimizationFindings.organizationId, b.org(ctx)), q.status === "all" ? undefined : eq(aiOptimizationFindings.status, (q.status ?? "open") as "open"))).orderBy(desc(aiOptimizationFindings.estimatedAnnualSavings)).limit(500));
      return rows.map(findingView);
    },
    async decideFinding(ctx: TenantContext, id: string, raw: unknown) {
      await b.require(ctx, "ai_ops.cost.manage");
      b.uuidOr404(id, "Finding");
      const input = parse(z.object({ status: z.enum(["accepted", "dismissed", "resolved", "open"]), note: text(2000).optional() }), raw);
      const [r] = await b.tenant(ctx, (tx) => tx.update(aiOptimizationFindings).set({ status: input.status, note: input.note ?? null, decidedBy: b.userId(ctx) }).where(and(eq(aiOptimizationFindings.organizationId, b.org(ctx)), eq(aiOptimizationFindings.id, id))).returning());
      if (!r) throw notFound("Finding", id);
      await b.record(ctx, "ai_ops.finding_decided", "ai_optimization_finding", id, { after: input, metadata: { kind: r.kind, estimatedAnnualSavings: r.estimatedAnnualSavings } });
      return findingView(r);
    },
    async runScan(ctx: TenantContext) {
      await b.require(ctx, "ai_ops.cost.manage");
      const res = await scan(b.org(ctx));
      await b.record(ctx, "ai_ops.optimization_scan", "ai_optimization_finding", b.org(ctx), { metadata: res });
      return res;
    },
    findingKinds: FINDING_KINDS,

    // Value ledger
    async listValue(ctx: TenantContext) {
      await b.require(ctx, "ai_ops.cost.read");
      const rows = await b.tenant(ctx, (tx) => tx.select().from(aiValueRecords).where(eq(aiValueRecords.organizationId, b.org(ctx))).orderBy(desc(aiValueRecords.recordedAt)).limit(1000));
      return rows.map((r) => ({ ...r, recordedAt: r.recordedAt.toISOString() }));
    },
    async addValue(ctx: TenantContext, raw: unknown) {
      await b.require(ctx, "ai_ops.cost.manage");
      const input = parse(valueSchema, raw);
      const [r] = await b.tenant(ctx, (tx) => tx.insert(aiValueRecords).values({ ...input, basis: input.kind === "realized" ? "measured" : "estimated", organizationId: b.org(ctx), createdBy: b.userId(ctx) }).returning());
      await b.record(ctx, "ai_ops.value_recorded", "ai_value_record", r!.id, { after: input });
      return { ...r!, recordedAt: r!.recordedAt.toISOString() };
    },
    /** Event-derived value from Workflow Intelligence: the latest measurement per implementation replaces the previous one. */
    async onWorkflowRoiMeasured(orgId: string, p: { implementationId: string; workflowId: string; measurementId: string; actualAnnualSavings: number | null }) {
      if (p.actualAnnualSavings == null || !(await deps.modules.isEnabled(orgId, "ai_operations"))) return;
      await b.orgScope(orgId, (tx) => tx.insert(aiValueRecords).values({ organizationId: orgId, kind: "realized", basis: "measured", annualValueUsd: p.actualAnnualSavings!, title: "Measured savings from a Workflow Intelligence implementation", description: `Measurement ${p.measurementId}`, sourceModule: "workflow_intelligence", sourceRef: p.implementationId })
        .onConflictDoUpdate({ target: [aiValueRecords.organizationId, aiValueRecords.sourceModule, aiValueRecords.sourceRef], set: { annualValueUsd: p.actualAnnualSavings!, description: `Measurement ${p.measurementId}`, recordedAt: new Date() } }));
    },

    // Center of Excellence
    async listCoe(ctx: TenantContext) {
      await b.require(ctx, "ai_ops.read");
      const admin = await b.can(ctx, "ai_ops.admin");
      const rows = await b.tenant(ctx, (tx) => tx.select().from(aiCoeItems).where(and(eq(aiCoeItems.organizationId, b.org(ctx)), admin ? undefined : eq(aiCoeItems.status, "published"))).orderBy(asc(aiCoeItems.kind), asc(aiCoeItems.title)));
      return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), reviewOverdue: !!r.reviewDate && r.reviewDate < today() }));
    },
    async saveCoe(ctx: TenantContext, id: string | null, raw: unknown) {
      await b.require(ctx, "ai_ops.admin");
      const input = parse(id ? coeSchema.partial() : coeSchema, raw);
      const row = await b.tenant(ctx, async (tx) => {
        await b.assertMember(tx, b.org(ctx), input.ownerUserId, "Owner");
        if (!id) return (await tx.insert(aiCoeItems).values({ ...(input as z.output<typeof coeSchema>), organizationId: b.org(ctx), createdBy: b.userId(ctx) }).onConflictDoNothing().returning())[0] ?? (() => { throw conflict("An item with this kind and title already exists."); })();
        b.uuidOr404(id, "Item");
        const [u] = await tx.update(aiCoeItems).set({ ...input, updatedAt: new Date() }).where(and(eq(aiCoeItems.organizationId, b.org(ctx)), eq(aiCoeItems.id, id))).returning();
        if (!u) throw notFound("Item", id);
        return u;
      });
      await b.record(ctx, id ? "ai_ops.coe_updated" : "ai_ops.coe_created", "ai_coe_item", row.id, { after: { ...input, body: input.body ? `${input.body.length} chars` : undefined } });
      return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
    },
    async listTemplates(ctx: TenantContext) {
      await b.require(ctx, "ai_ops.read");
      const admin = await b.can(ctx, "ai_ops.admin");
      await seed(b.org(ctx));
      const rows = await b.tenant(ctx, (tx) => tx.select().from(aiImplementationTemplates).where(and(eq(aiImplementationTemplates.organizationId, b.org(ctx)), admin ? undefined : eq(aiImplementationTemplates.status, "published"))).orderBy(asc(aiImplementationTemplates.name)));
      return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() }));
    },
    async saveTemplate(ctx: TenantContext, id: string | null, raw: unknown) {
      await b.require(ctx, "ai_ops.admin");
      const input = parse(id ? templateSchema.partial() : templateSchema, raw);
      const row = await b.tenant(ctx, async (tx) => {
        if (!id) {
          const [dup] = await tx.select({ id: aiImplementationTemplates.id }).from(aiImplementationTemplates).where(and(eq(aiImplementationTemplates.organizationId, b.org(ctx)), eq(aiImplementationTemplates.name, input.name!))).limit(1);
          if (dup) throw conflict(`A template named "${input.name}" already exists.`);
          return (await tx.insert(aiImplementationTemplates).values({ ...(input as z.output<typeof templateSchema>), organizationId: b.org(ctx), createdBy: b.userId(ctx) }).returning())[0]!;
        }
        b.uuidOr404(id, "Template");
        const [u] = await tx.update(aiImplementationTemplates).set({ ...input, updatedAt: new Date() }).where(and(eq(aiImplementationTemplates.organizationId, b.org(ctx)), eq(aiImplementationTemplates.id, id))).returning();
        if (!u) throw notFound("Template", id);
        return u;
      });
      await b.record(ctx, id ? "ai_ops.template_updated" : "ai_ops.template_created", "ai_implementation_template", row.id, { after: { name: input.name, status: input.status } });
      return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
    },
    toolCategories: TOOL_CATEGORIES,
  };
}

export type Governance = ReturnType<typeof makeGovernance>;
