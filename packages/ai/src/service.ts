import { z } from "zod";
import { aiModels, aiProviders, aiRuns, and, desc, eq, isNull, lt, or, scopeOf, type Database } from "@eaop/db";
import { AuditActions, type AuditService } from "@eaop/audit";
import { type EventBus } from "@eaop/events";
import { redactString, type Logger, type Metrics } from "@eaop/observability";
import { type PolicyService } from "@eaop/policies";
import { type Authorizer } from "@eaop/rbac";
import { type SecretStore } from "@eaop/secrets";
import { RATE_LIMITS, sha256, type RateLimiter } from "@eaop/security";
import { AppError, decodeCursor, isAppError, encodeCursor, notFound, type OwnerId, type Page, type TenantContext } from "@eaop/shared-types";
import { USAGE_METRICS, type UsageService } from "@eaop/usage";
import { PLATFORM_AI_CATALOG, UNIMPLEMENTED_PROVIDER_KINDS } from "./catalog";
import { estimateCostUsd, rankModels, type RoutableModel, type RoutingPolicy } from "./router";
import { type AIMessage, type AIPolicyHook, type AIProvider, type DataClassification, type Effort, type ModelTier, type ProviderKind } from "./types";

export const aiExecuteSchema = z.object({
  moduleId: z.string().min(1).max(64),
  useCase: z.string().regex(/^[a-z][a-z0-9_.-]{1,100}$/),
  system: z.string().max(200_000).optional(),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(1_000_000) })).min(1).max(200),
  maxTokens: z.number().int().min(1).max(128_000).default(4_000),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  responseFormat: z.enum(["text", "json"]).default("text"),
  dataClassification: z.enum(["public", "internal", "confidential", "restricted"]).default("internal"),
  model: z.string().max(120).optional(),
  provider: z.string().max(64).optional(),
  tier: z.enum(["economy", "standard", "premium"]).optional(),
  capabilities: z.array(z.string().max(40)).max(10).optional(),
  promptTemplate: z.object({ id: z.string().max(120), version: z.string().max(40) }).optional(),
  /** References for explainability (workflow id, source document ids, ...). Never content. */
  references: z.record(z.unknown()).optional(),
});
export type AIExecuteInput = z.input<typeof aiExecuteSchema>;

export interface AIExecuteResult {
  runId: string;
  text: string;
  provider: string;
  model: string;
  servedModel: string;
  finishReason: string;
  usage: { inputTokens: number; outputTokens: number };
  estimatedCostUsd: number;
  latencyMs: number;
  policy: { decision: string; reasons: string[] };
}

export interface AIRunView {
  id: string;
  providerKey: string;
  modelKey: string;
  moduleId: string;
  useCase: string;
  actorType: string;
  actorId: string;
  status: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  estimatedCostUsd: number;
  promptRetention: string;
  promptTemplateId: string | null;
  promptTemplateVersion: string | null;
  promptHash: string | null;
  policyDecision: string | null;
  policyReasons: string[] | null;
  errorCode: string | null;
  errorMessage: string | null;
  request: unknown;
  response: unknown;
  metadata: Record<string, unknown>;
  correlationId: string | null;
  createdAt: string;
}

export interface ProviderView {
  id: string;
  key: string;
  name: string;
  kind: string;
  status: string;
  scope: "platform" | "organization";
  implemented: boolean;
  config: Record<string, unknown>;
  hasCredential: boolean;
  models: Array<{ id: string; modelKey: string; displayName: string; tier: string; capabilities: string[]; contextWindow: number | null; inputCostPerMtok: number; outputCostPerMtok: number; maxDataClassification: string; status: string }>;
}

export const configureProviderSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_-]{1,40}$/),
  name: z.string().min(1).max(120),
  kind: z.enum(["anthropic", "openai", "openai_compatible", "azure_openai", "google", "bedrock", "local"]),
  config: z.record(z.unknown()).default({}),
  apiKey: z.string().min(1).max(5000).optional(),
});
export const modelSchema = z.object({
  modelKey: z.string().min(1).max(120),
  displayName: z.string().min(1).max(120),
  capabilities: z.array(z.string().max(40)).max(20).default(["text"]),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  inputCostPerMtok: z.number().min(0).max(10_000),
  outputCostPerMtok: z.number().min(0).max(10_000),
  tier: z.enum(["economy", "standard", "premium"]).default("standard"),
  maxDataClassification: z.enum(["public", "internal", "confidential", "restricted"]).default("internal"),
});

export interface AIService {
  /** THE way modules call models. Never call providers directly. */
  execute(ctx: TenantContext, input: AIExecuteInput): Promise<AIExecuteResult>;
  registerPolicyHook(name: string, hook: AIPolicyHook): void;
  registerRoutingPolicy(name: string, policy: RoutingPolicy): void;
  /** Seed platform providers/models (system scope, boot). */
  syncCatalog(): Promise<void>;
  listProviders(ctx: TenantContext): Promise<ProviderView[]>;
  configureProvider(ctx: TenantContext, input: z.input<typeof configureProviderSchema>): Promise<ProviderView>;
  setProviderStatus(ctx: TenantContext, providerId: string, status: "enabled" | "disabled"): Promise<void>;
  upsertModel(ctx: TenantContext, providerId: string, input: z.input<typeof modelSchema>): Promise<void>;
  setModelStatus(ctx: TenantContext, modelId: string, status: "active" | "disabled"): Promise<void>;
  listRuns(ctx: TenantContext, q: { moduleId?: string; status?: string; limit?: number; cursor?: string }): Promise<Page<AIRunView>>;
  getRun(ctx: TenantContext, id: string): Promise<AIRunView>;
  providerStatus(): Promise<Array<{ key: string; kind: string; status: string; implemented: boolean }>>;
}

export function createAIService(deps: {
  db: Database;
  providers: AIProvider[];
  secrets: SecretStore;
  authorizer: Authorizer;
  policies: PolicyService;
  audit: AuditService;
  bus: EventBus;
  usage: UsageService;
  rateLimiter: RateLimiter;
  logger: Logger;
  metrics: Metrics;
  env: Record<string, string | undefined>;
  environment: string;
  retentionFor: (organizationId: string) => Promise<"none" | "metadata" | "full">;
  /** Attribution guard: only "core" or a module enabled for the tenant may be named as the caller. */
  isModuleEnabled: (organizationId: string, moduleId: string) => Promise<boolean>;
  timeoutMs?: number;
}): AIService {
  const { db, secrets, authorizer, audit, bus, usage, logger, metrics } = deps;
  const adapters = new Map<string, AIProvider>(deps.providers.map((p) => [p.kind, p]));
  const hooks = new Map<string, AIPolicyHook>();
  const routingPolicies = new Map<string, RoutingPolicy>();
  const isProd = deps.environment === "production";

  deps.policies.registerKind({
    key: "ai_usage",
    owner: "core",
    description: "Controls which modules/use cases may use which model tiers and data classifications.",
    attributes: {
      "resource.attributes.moduleId": "calling module",
      "resource.attributes.useCase": "use case key",
      "resource.attributes.tier": "economy | standard | premium",
      "resource.attributes.provider": "provider key",
      "resource.attributes.model": "model key",
      "context.dataClassification": "public | internal | confidential | restricted",
    },
  });

  async function visibleModels(ctx: TenantContext): Promise<RoutableModel[]> {
    const rows = await db.withTenant(scopeOf(ctx), (tx) =>
      tx
        .select({ p: aiProviders, m: aiModels })
        .from(aiModels)
        .innerJoin(aiProviders, eq(aiProviders.id, aiModels.providerId))
        .where(and(eq(aiProviders.status, "enabled"), eq(aiModels.status, "active"), or(isNull(aiProviders.organizationId), eq(aiProviders.organizationId, ctx.organizationId)))),
    );
    return rows
      .filter((r) => !(isProd && r.p.kind === "sandbox"))
      .map((r) => ({
        providerId: r.p.id,
        providerKey: r.p.key,
        providerKind: r.p.kind,
        organizationId: r.p.organizationId,
        modelKey: r.m.modelKey,
        capabilities: r.m.capabilities,
        tier: r.m.tier,
        maxDataClassification: r.m.maxDataClassification,
        inputCostPerMtok: Number(r.m.inputCostPerMtok),
        outputCostPerMtok: Number(r.m.outputCostPerMtok),
        contextWindow: r.m.contextWindow,
      }));
  }

  async function credentialFor(m: RoutableModel): Promise<string | undefined> {
    const [p] = await db.withSystem("ai.provider_credential", (tx) => tx.select().from(aiProviders).where(eq(aiProviders.id, m.providerId)).limit(1));
    if (!p) return undefined;
    if (p.credentialSecretRef) return secrets.get(p.credentialSecretRef, p.organizationId);
    const envName = PLATFORM_AI_CATALOG.find((c) => c.key === p.key)?.credentialEnv;
    return p.organizationId === null && envName ? deps.env[envName] : undefined;
  }

  async function providerConfig(id: string) {
    const [p] = await db.withSystem("ai.provider_config", (tx) => tx.select({ config: aiProviders.config }).from(aiProviders).where(eq(aiProviders.id, id)).limit(1));
    return p?.config ?? {};
  }

  type RunInsert = typeof aiRuns.$inferInsert;
  async function persistRun(ctx: TenantContext, values: Omit<RunInsert, "organizationId" | "actorType" | "actorId" | "correlationId">) {
    // retention "none": keep no derivative of the content either (no hash, no sizes).
    if (values.promptRetention === "none") values = { ...values, promptHash: null, promptChars: null, responseChars: null, request: null, response: null };
    const [row] = await db.withTenant(scopeOf(ctx), (tx) =>
      tx.insert(aiRuns).values({ ...values, organizationId: ctx.organizationId, actorType: ctx.actor.type, actorId: ctx.actor.id, correlationId: ctx.correlationId }).returning({ id: aiRuns.id }),
    );
    return row!.id;
  }

  const view = (r: typeof aiRuns.$inferSelect): AIRunView => ({
    ...r,
    estimatedCostUsd: Number(r.estimatedCostUsd),
    policyReasons: r.policyReasons ?? null,
    metadata: r.metadata ?? {},
    createdAt: r.createdAt.toISOString(),
  });

  const service: AIService = {
    registerPolicyHook(name, hook) {
      if (hooks.has(name)) throw new Error(`AI policy hook "${name}" already registered`);
      hooks.set(name, hook);
    },
    registerRoutingPolicy(name, policy) {
      if (routingPolicies.has(name)) throw new Error(`Routing policy "${name}" already registered`);
      routingPolicies.set(name, policy);
    },

    async execute(ctx, raw) {
      if (ctx.actor.type !== "system") await authorizer.require(ctx, "ai.use");
      const input = aiExecuteSchema.parse(raw);
      if (input.moduleId !== "core" && !(await deps.isModuleEnabled(ctx.organizationId, input.moduleId))) {
        throw new AppError("MODULE_NOT_ENABLED", undefined, { moduleId: input.moduleId });
      }
      const rl = await deps.rateLimiter.consume(`ai:${ctx.organizationId}:${ctx.actor.id}`, RATE_LIMITS.ai);
      if (!rl.allowed) throw new AppError("RATE_LIMITED", "AI request rate limit reached.", { retryAfterSeconds: rl.retryAfterSeconds });

      const retention = await deps.retentionFor(ctx.organizationId);
      const estTokens = Math.ceil(((input.system ?? "").length + input.messages.reduce((n, m) => n + m.content.length, 0)) / 4);
      let candidates = (await visibleModels(ctx)).filter((m) => !UNIMPLEMENTED_PROVIDER_KINDS.includes(m.providerKind as ProviderKind));
      const ranking = rankModels(candidates, { model: input.model, provider: input.provider, capabilities: input.capabilities, tier: input.tier as ModelTier | undefined, dataClassification: input.dataClassification as DataClassification, estimatedInputTokens: estTokens });
      candidates = ranking.ranked;
      for (const policy of routingPolicies.values()) {
        candidates = policy(candidates, { ...input, dataClassification: input.dataClassification as DataClassification, organizationId: ctx.organizationId, useCase: input.useCase, moduleId: input.moduleId, tier: input.tier as ModelTier | undefined });
      }
      const chosen = candidates[0];
      if (!chosen) {
        throw new AppError("NOT_CONFIGURED", "No enabled AI model satisfies this request.", { excluded: ranking.excluded.slice(0, 10), hint: "Configure an AI provider under Admin → AI Providers." });
      }

      const base = {
        providerKey: chosen.providerKey,
        modelKey: chosen.modelKey,
        moduleId: input.moduleId,
        useCase: input.useCase,
        promptRetention: retention,
        promptTemplateId: input.promptTemplate?.id ?? null,
        promptTemplateVersion: input.promptTemplate?.version ?? null,
        metadata: { references: input.references ?? {}, dataClassification: input.dataClassification, routingExcluded: ranking.excluded.slice(0, 10) },
      };

      // ── Policy: org "ai_usage" policies + module hooks (e.g. DLP). ───────────
      const pol = await deps.policies.evaluateKind(ctx, "ai_usage", {
        subject: { type: ctx.actor.type, id: ctx.actor.id },
        resource: { type: "ai_model", id: chosen.modelKey, attributes: { moduleId: input.moduleId, useCase: input.useCase, tier: chosen.tier, provider: chosen.providerKey, model: chosen.modelKey } },
        action: "ai.generate",
        context: { dataClassification: input.dataClassification },
      });
      const reasons = [...pol.reasons];
      let decision: string = pol.effect;
      let request: { system?: string; messages: AIMessage[] } = { system: input.system, messages: input.messages };
      if (decision === "ALLOW") {
        for (const [name, hook] of hooks) {
          const r = await hook({ organizationId: ctx.organizationId, moduleId: input.moduleId, useCase: input.useCase, dataClassification: input.dataClassification as DataClassification, model: { provider: chosen.providerKey, model: chosen.modelKey, tier: chosen.tier }, request });
          reasons.push(...(r.reasons ?? []).map((x) => `[${name}] ${x}`));
          if (r.decision === "REDACT" && r.request) {
            request = r.request;
            decision = "ALLOW";
          } else if (r.decision !== "ALLOW") {
            decision = r.decision;
            break;
          }
        }
      }
      const promptText = JSON.stringify(request);
      const promptHash = sha256(promptText);
      if (decision !== "ALLOW") {
        const status = decision === "DENY" ? "blocked" : "pending_approval";
        const runId = await persistRun(ctx, { ...base, status, policyDecision: decision, policyReasons: reasons, promptHash, promptChars: promptText.length, request: retention === "full" ? request : null });
        await bus.publish(ctx, "ai.run.failed", { runId, moduleId: input.moduleId, useCase: input.useCase, status, errorCode: decision });
        await audit.record(ctx, { module: input.moduleId as OwnerId, action: "ai.run_blocked", resourceType: "ai_run", resourceId: runId, outcome: "denied", metadata: { decision, reasons: reasons.slice(0, 10) } });
        throw new AppError(decision === "DENY" ? "POLICY_DENIED" : "APPROVAL_REQUIRED", undefined, { runId, decision, reasons: reasons.slice(0, 10) });
      }

      // ── Execute. ────────────────────────────────────────────────────────────
      const adapter = adapters.get(chosen.providerKind === "local" ? "local" : chosen.providerKind);
      const started = performance.now();
      try {
        if (!adapter) throw new AppError("NOT_IMPLEMENTED", `No adapter for provider kind "${chosen.providerKind}".`);
        const res = await adapter.generate(
          { model: chosen.modelKey, system: request.system, messages: request.messages, maxTokens: input.maxTokens, effort: input.effort as Effort | undefined, responseFormat: input.responseFormat },
          { apiKey: await credentialFor(chosen), config: await providerConfig(chosen.providerId) },
          AbortSignal.timeout(deps.timeoutMs ?? 10 * 60_000),
        );
        const latencyMs = Math.round(performance.now() - started);
        // Cost is attributed to the model that served the request (fallbacks may switch models).
        const served = (await visibleModels(ctx)).find((m) => m.providerKey === chosen.providerKey && m.modelKey === res.servedModel) ?? chosen;
        const cost = estimateCostUsd(served, res.usage.inputTokens, res.usage.outputTokens);
        const refused = res.finishReason === "refusal";
        const runId = await persistRun(ctx, {
          ...base,
          modelKey: chosen.modelKey,
          status: refused ? "blocked" : "succeeded",
          inputTokens: res.usage.inputTokens,
          outputTokens: res.usage.outputTokens,
          latencyMs,
          estimatedCostUsd: String(cost),
          policyDecision: "ALLOW",
          policyReasons: reasons,
          promptHash,
          promptChars: promptText.length,
          responseChars: res.text.length,
          request: retention === "full" ? request : null,
          response: retention === "full" ? { text: res.text, finishReason: res.finishReason } : null,
          errorCode: refused ? "PROVIDER_REFUSAL" : null,
          errorMessage: refused ? `Provider declined the request${res.refusalCategory ? ` (${res.refusalCategory})` : ""}.` : null,
          metadata: { ...base.metadata, servedModel: res.servedModel, finishReason: res.finishReason },
        });
        const userId = ctx.actor.type === "user" ? ctx.actor.id : null;
        const dims = { moduleId: input.moduleId as OwnerId, userId, aiProvider: chosen.providerKey, aiModel: res.servedModel, dimensions: { useCase: input.useCase } };
        await usage.record(ctx, [
          { ...dims, metric: USAGE_METRICS.AI_RUNS.key, unit: USAGE_METRICS.AI_RUNS.unit, quantity: 1, dedupeKey: `${runId}:runs` },
          { ...dims, metric: USAGE_METRICS.AI_INPUT_TOKENS.key, unit: USAGE_METRICS.AI_INPUT_TOKENS.unit, quantity: res.usage.inputTokens, dedupeKey: `${runId}:in` },
          { ...dims, metric: USAGE_METRICS.AI_OUTPUT_TOKENS.key, unit: USAGE_METRICS.AI_OUTPUT_TOKENS.unit, quantity: res.usage.outputTokens, dedupeKey: `${runId}:out` },
          { ...dims, metric: USAGE_METRICS.AI_COST.key, unit: USAGE_METRICS.AI_COST.unit, quantity: cost, dedupeKey: `${runId}:cost` },
        ]);
        metrics.increment("eaop_ai_runs_total", { provider: chosen.providerKey, model: res.servedModel, outcome: refused ? "refused" : "ok" });
        metrics.observe("eaop_ai_latency_ms", latencyMs, { provider: chosen.providerKey });
        if (refused) {
          await bus.publish(ctx, "ai.run.failed", { runId, moduleId: input.moduleId, useCase: input.useCase, status: "refused", errorCode: "PROVIDER_REFUSAL" });
          throw new AppError("POLICY_DENIED", "The AI provider declined this request.", { runId, category: res.refusalCategory ?? null });
        }
        await bus.publish(ctx, "ai.run.completed", { runId, moduleId: input.moduleId, useCase: input.useCase, provider: chosen.providerKey, model: res.servedModel, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, costUsd: cost, latencyMs });
        return { runId, text: res.text, provider: chosen.providerKey, model: chosen.modelKey, servedModel: res.servedModel, finishReason: res.finishReason, usage: res.usage, estimatedCostUsd: cost, latencyMs, policy: { decision: "ALLOW", reasons } };
      } catch (err) {
        if (isAppError(err) && (err.code === "POLICY_DENIED" || err.code === "APPROVAL_REQUIRED")) throw err;
        const latencyMs = Math.round(performance.now() - started);
        const code = isAppError(err) ? err.code : "INTERNAL";
        const message = redactString(err instanceof Error ? err.message : String(err)).slice(0, 500);
        const runId = await persistRun(ctx, { ...base, status: "failed", latencyMs, policyDecision: "ALLOW", policyReasons: reasons, promptHash, promptChars: promptText.length, errorCode: code, errorMessage: message, request: retention === "full" ? request : null });
        metrics.increment("eaop_ai_runs_total", { provider: chosen.providerKey, model: chosen.modelKey, outcome: "error" });
        logger.warn("ai.run_failed", { runId, provider: chosen.providerKey, model: chosen.modelKey, code });
        await bus.publish(ctx, "ai.run.failed", { runId, moduleId: input.moduleId, useCase: input.useCase, status: "failed", errorCode: code });
        if (isAppError(err)) throw new AppError(err.code, err.message, { ...(err.details ?? {}), runId }, { retryable: err.retryable });
        throw new AppError("UPSTREAM_ERROR", "The AI provider call failed.", { runId });
      }
    },

    async syncCatalog() {
      await db.withSystem("ai.sync_catalog", async (tx) => {
        for (const p of PLATFORM_AI_CATALOG) {
          if (p.developmentOnly && isProd) continue;
          const hasCred = p.kind === "sandbox" || (p.credentialEnv ? !!deps.env[p.credentialEnv] : false);
          const [existing] = await tx.select().from(aiProviders).where(and(isNull(aiProviders.organizationId), eq(aiProviders.key, p.key))).limit(1);
          const status = hasCred ? (existing?.status === "disabled" ? "disabled" : "enabled") : "not_configured";
          const providerId = existing
            ? (await tx.update(aiProviders).set({ name: p.name, kind: p.kind, status, config: { ...p.config, ...existing.config }, updatedAt: new Date() }).where(eq(aiProviders.id, existing.id)).returning())[0]!.id
            : (await tx.insert(aiProviders).values({ organizationId: null, key: p.key, name: p.name, kind: p.kind, status, config: p.config }).returning())[0]!.id;
          for (const m of p.models) {
            await tx
              .insert(aiModels)
              .values({ providerId, organizationId: null, modelKey: m.modelKey, displayName: m.displayName, capabilities: m.capabilities, contextWindow: m.contextWindow, maxOutputTokens: m.maxOutputTokens, inputCostPerMtok: String(m.inputCostPerMtok), outputCostPerMtok: String(m.outputCostPerMtok), tier: m.tier, maxDataClassification: m.maxDataClassification })
              .onConflictDoNothing();
          }
        }
      });
    },

    async listProviders(ctx) {
      await authorizer.require(ctx, "ai.provider.read");
      const rows = await db.withTenant(scopeOf(ctx), async (tx) => {
        const providers = await tx.select().from(aiProviders).where(or(isNull(aiProviders.organizationId), eq(aiProviders.organizationId, ctx.organizationId)));
        const models = await tx.select().from(aiModels).where(or(isNull(aiModels.organizationId), eq(aiModels.organizationId, ctx.organizationId)));
        return { providers, models };
      });
      return rows.providers
        .filter((p) => !(isProd && p.kind === "sandbox"))
        .map((p) => ({
          id: p.id,
          key: p.key,
          name: p.name,
          kind: p.kind,
          status: p.status,
          scope: p.organizationId ? ("organization" as const) : ("platform" as const),
          implemented: adapters.has(p.kind) && !UNIMPLEMENTED_PROVIDER_KINDS.includes(p.kind),
          config: p.config,
          hasCredential: !!p.credentialSecretRef || (p.organizationId === null && !!PLATFORM_AI_CATALOG.find((c) => c.key === p.key)?.credentialEnv && !!deps.env[PLATFORM_AI_CATALOG.find((c) => c.key === p.key)!.credentialEnv!]),
          models: rows.models
            .filter((m) => m.providerId === p.id)
            .map((m) => ({ id: m.id, modelKey: m.modelKey, displayName: m.displayName, tier: m.tier, capabilities: m.capabilities, contextWindow: m.contextWindow, inputCostPerMtok: Number(m.inputCostPerMtok), outputCostPerMtok: Number(m.outputCostPerMtok), maxDataClassification: m.maxDataClassification, status: m.status })),
        }));
    },

    async configureProvider(ctx, raw) {
      await authorizer.require(ctx, "ai.provider.manage");
      const input = configureProviderSchema.parse(raw);
      if (/key|secret|token|password/i.test(Object.keys(input.config).join(","))) throw new AppError("VALIDATION_FAILED", "Put credentials in apiKey, not config.");
      const ref = input.apiKey ? await secrets.put({ organizationId: ctx.organizationId, name: `ai-provider:${input.key}`, value: input.apiKey }) : null;
      const [row] = await db.withTenant(scopeOf(ctx), (tx) =>
        tx
          .insert(aiProviders)
          .values({ organizationId: ctx.organizationId, key: input.key, name: input.name, kind: input.kind, status: ref || input.kind === "local" ? "enabled" : "not_configured", config: input.config, credentialSecretRef: ref })
          .onConflictDoUpdate({ target: [aiProviders.organizationId, aiProviders.key], set: { name: input.name, kind: input.kind, config: input.config, ...(ref ? { credentialSecretRef: ref, status: "enabled" as const } : {}), updatedAt: new Date() } })
          .returning(),
      );
      await audit.record(ctx, { action: AuditActions.AI_PROVIDER_CHANGED, resourceType: "ai_provider", resourceId: row!.id, after: { key: input.key, kind: input.kind, config: input.config, credentialChanged: !!ref } });
      return (await service.listProviders(ctx)).find((p) => p.id === row!.id)!;
    },

    async setProviderStatus(ctx, providerId, status) {
      await authorizer.require(ctx, "ai.provider.manage");
      const [row] = await db.withTenant(scopeOf(ctx), (tx) =>
        tx.update(aiProviders).set({ status, updatedAt: new Date() }).where(and(eq(aiProviders.id, providerId), eq(aiProviders.organizationId, ctx.organizationId))).returning(),
      );
      if (!row) throw notFound("AI provider (organization-owned)", providerId);
      await audit.record(ctx, { action: AuditActions.AI_PROVIDER_CHANGED, resourceType: "ai_provider", resourceId: providerId, after: { status } });
    },

    async upsertModel(ctx, providerId, raw) {
      await authorizer.require(ctx, "ai.provider.manage");
      const input = modelSchema.parse(raw);
      const [p] = await db.withTenant(scopeOf(ctx), (tx) => tx.select().from(aiProviders).where(and(eq(aiProviders.id, providerId), eq(aiProviders.organizationId, ctx.organizationId))).limit(1));
      if (!p) throw notFound("AI provider (organization-owned)", providerId);
      await db.withTenant(scopeOf(ctx), (tx) =>
        tx
          .insert(aiModels)
          .values({ providerId, organizationId: ctx.organizationId, modelKey: input.modelKey, displayName: input.displayName, capabilities: input.capabilities, contextWindow: input.contextWindow ?? null, maxOutputTokens: input.maxOutputTokens ?? null, inputCostPerMtok: String(input.inputCostPerMtok), outputCostPerMtok: String(input.outputCostPerMtok), tier: input.tier, maxDataClassification: input.maxDataClassification })
          .onConflictDoUpdate({ target: [aiModels.providerId, aiModels.modelKey], set: { displayName: input.displayName, capabilities: input.capabilities, inputCostPerMtok: String(input.inputCostPerMtok), outputCostPerMtok: String(input.outputCostPerMtok), tier: input.tier, maxDataClassification: input.maxDataClassification, updatedAt: new Date() } }),
      );
      await audit.record(ctx, { action: AuditActions.AI_MODEL_CHANGED, resourceType: "ai_provider", resourceId: providerId, after: input });
    },

    async setModelStatus(ctx, modelId, status) {
      await authorizer.require(ctx, "ai.provider.manage");
      const [row] = await db.withTenant(scopeOf(ctx), (tx) => tx.update(aiModels).set({ status, updatedAt: new Date() }).where(and(eq(aiModels.id, modelId), eq(aiModels.organizationId, ctx.organizationId))).returning());
      if (!row) throw notFound("AI model (organization-owned)", modelId);
      await audit.record(ctx, { action: AuditActions.AI_MODEL_CHANGED, resourceType: "ai_model", resourceId: modelId, after: { status } });
    },

    async listRuns(ctx, q) {
      await authorizer.require(ctx, "ai.run.read");
      const limit = Math.min(q.limit ?? 50, 200);
      const cursor = decodeCursor(q.cursor);
      const conds = [eq(aiRuns.organizationId, ctx.organizationId)];
      if (q.moduleId) conds.push(eq(aiRuns.moduleId, q.moduleId));
      if (q.status) conds.push(eq(aiRuns.status, q.status as "succeeded"));
      if (cursor) conds.push(or(lt(aiRuns.createdAt, new Date(cursor.t)), and(eq(aiRuns.createdAt, new Date(cursor.t)), lt(aiRuns.id, cursor.id)))!);
      const rows = await db.withTenant(scopeOf(ctx), (tx) => tx.select().from(aiRuns).where(and(...conds)).orderBy(desc(aiRuns.createdAt), desc(aiRuns.id)).limit(limit + 1));
      const last = rows.length > limit ? rows[limit - 1] : undefined;
      return { data: rows.slice(0, limit).map(view), nextCursor: last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : undefined };
    },

    async getRun(ctx, id) {
      await authorizer.require(ctx, "ai.run.read");
      const [row] = await db.withTenant(scopeOf(ctx), (tx) => tx.select().from(aiRuns).where(and(eq(aiRuns.id, id), eq(aiRuns.organizationId, ctx.organizationId))).limit(1));
      if (!row) throw notFound("AI run", id);
      return view(row);
    },

    async providerStatus() {
      const rows = await db.withSystem("ai.provider_status", (tx) => tx.select().from(aiProviders).where(isNull(aiProviders.organizationId)));
      return rows.map((p) => ({ key: p.key, kind: p.kind, status: p.status, implemented: adapters.has(p.kind) && !UNIMPLEMENTED_PROVIDER_KINDS.includes(p.kind) }));
    },
  };
  return service;
}
