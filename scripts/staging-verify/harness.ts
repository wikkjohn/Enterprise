/**
 * Staging verification of a real AI provider.
 *
 * Creates a dedicated staging organization, configures an organization-owned
 * Anthropic provider in it, and checks four things end to end through the
 * real platform services, the real Anthropic adapter and the real SDK — with
 * every byte that crosses the wire captured:
 *
 *   1. grounding   — Knowledge answers are generated from the retrieved sources
 *                    and every citation points at a retrieved passage;
 *   2. costs       — recorded tokens/costs equal what the provider reported,
 *                    priced at the contract price, with nothing unmetered;
 *   3. redaction   — DLP-redacted or blocked data never reaches the provider;
 *   4. fail-closed — a routing policy with no qualifying model fails with a
 *                    clean NOT_CONFIGURED and makes no provider call.
 *
 * `mode: "mock"` points the provider at a local Messages-API stand-in so the
 * harness itself can be tested without a key; `mode: "live"` uses the key.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { PLATFORM_AI_CATALOG } from "../../packages/ai/src/catalog";
import { aiRuns, and, eq, memberships, sql, usageEvents, users } from "../../packages/db/src";
import { type Platform } from "../../packages/platform/src";
import { hashPassword } from "../../packages/security/src";
import { type TenantContext } from "../../packages/shared-types/src";
import { aiOpsService } from "../../modules/ai-operations/src";
import { dataSecurityService } from "../../modules/data-security/src";
import { knowledgeService } from "../../modules/knowledge-verification/src";
import { knowledgeAnswers } from "../../modules/knowledge-verification/src/schema";
import { installWireCapture, type WireExchange } from "./wire";

export const STAGING_PROVIDER_KEY = "anthropic-staging";

export interface ModelPrice { input: number; output: number }

export interface VerifyOptions {
  mode: "live" | "mock";
  apiKey: string;
  /** Messages API base URL; only set for the mock (live uses the SDK default). */
  baseUrl?: string;
  /** Contract prices (USD per 1M tokens) to check recorded costs against. Defaults to the catalog list prices. */
  prices?: Record<string, ModelPrice>;
  /** Models to probe for cost. Defaults to every Anthropic catalog model. */
  models?: string[];
  log?: (line: string) => void;
  /** Test hook: false skips enabling Data Security, to prove the redaction check detects a leak. */
  enableDataSecurity?: boolean;
}

export interface Assertion { name: string; passed: boolean; observed?: unknown }
export interface CheckResult { id: "grounding" | "costs" | "redaction" | "fail_closed"; title: string; passed: boolean; assertions: Assertion[] }

export interface CostRow {
  runId: string;
  label: string;
  useCase: string;
  providerRequestId: string | null;
  messageId: string | null;
  requestedModel: string;
  servedModel: string;
  wireInputTokens: number;
  wireCacheCreationTokens: number;
  wireCacheReadTokens: number;
  wireOutputTokens: number;
  recordedInputTokens: number;
  recordedOutputTokens: number;
  recordedCostUsd: number;
  meteredCostUsd: number;
  expectedCostUsd: number;
  at: string;
}

export interface VerificationReport {
  mode: "live" | "mock";
  startedAt: string;
  finishedAt: string;
  organization: { id: string; slug: string; name: string };
  provider: { key: string; baseUrl: string };
  passed: boolean;
  checks: CheckResult[];
  costs: { rows: CostRow[]; totals: { byModel: Record<string, { requests: number; inputTokens: number; outputTokens: number; costUsd: number }>; costUsd: number }; providerRequests: number };
}

const SSN = "234-56-7891";
const CARD = "4111 1111 1111 1111";
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const KB_SSN = "345-67-8912";
const HR_SECRET = "Quillon";
const HR_FIGURE = "187,500";

const DOCS = {
  travel: {
    title: "Vantrel travel policy",
    text: "Employees travelling on Vantrel business receive a meal per diem of $73 per day. Hotel stays are reimbursed up to $214 per night. Economy class is required for flights shorter than six hours.",
  },
  equipment: {
    title: "Vantrel equipment policy",
    text: "Every Vantrel engineer receives a laptop refresh every 30 months. Each desk may have at most two external monitors.",
  },
  payrollContact: {
    title: "Vantrel payroll disputes",
    text: `Payroll disputes at Vantrel are handled by the payroll desk. The escalation contact on file is Dana Whitfield, SSN ${KB_SSN}, who responds within two business days.`,
  },
  compensation: {
    title: "Vantrel compensation bands",
    text: `The ${HR_SECRET} level 5 salary band at Vantrel is $${HR_FIGURE} to $212,000 per year.`,
  },
};

const MARKER = /\[(S\d+)\]/g;
const numbersIn = (s: string) => (s.replace(MARKER, "").match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, "").replace(/\.$/, ""));

export async function runStagingVerification(p: Platform, opts: VerifyOptions): Promise<VerificationReport> {
  const log = opts.log ?? (() => {});
  const startedAt = new Date().toISOString();
  const baseUrl = opts.baseUrl ?? "https://api.anthropic.com";
  const providerHost = new URL(baseUrl).host;
  const catalog = PLATFORM_AI_CATALOG.find((c) => c.key === "anthropic")!.models;
  const prices: Record<string, ModelPrice> = Object.fromEntries(catalog.map((m) => [m.modelKey, { input: m.inputCostPerMtok, output: m.outputCostPerMtok }]));
  Object.assign(prices, opts.prices ?? {});
  const probeModels = opts.models ?? catalog.map((m) => m.modelKey);

  const wire = installWireCapture((u) => u.host === providerHost && u.pathname.startsWith("/v1/messages"));
  const ledger: Array<{ label: string; runId: string; calls: WireExchange[] }> = [];
  const checks: CheckResult[] = [];

  /** Run fn and return the provider exchanges it caused (calls are sequential, so attribution is exact). */
  async function observe<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; calls: WireExchange[] }> {
    const mark = wire.exchanges.length;
    try {
      const value = await fn();
      return { value, calls: wire.since(mark) };
    } catch (error) {
      return { error, calls: wire.since(mark) };
    }
  }
  const sent = (calls: WireExchange[]) => calls.map((c) => c.requestBody).join("\n");

  try {
    // ── Staging organization and provider ───────────────────────────────────
    const stamp = randomBytes(3).toString("hex");
    const sys = { actor: { type: "system" as const, id: "staging-verify", label: "system:staging-verify" }, correlationId: randomUUID() };
    const pw = await hashPassword(randomBytes(24).toString("base64url"));
    const mkUser = async (role: string) => {
      const email = `staging-verify-${role}-${stamp}@example.invalid`;
      const [u] = await p.db.withSystem("staging_verify.user", (tx) => tx.insert(users).values({ email, name: `Staging ${role}`, passwordHash: pw, status: "active" }).returning());
      return u!;
    };
    const ctxOf = (orgId: string, u: { id: string; email: string }): TenantContext => ({ organizationId: orgId, actor: { type: "user", id: u.id, label: u.email }, correlationId: randomUUID(), cache: new Map() });
    const sysCtx = (orgId: string): TenantContext => ({ organizationId: orgId, ...sys, correlationId: randomUUID(), cache: new Map() });

    const adminUser = await mkUser("admin");
    const slug = `ai-staging-${stamp}`;
    const org = await p.organizations.create(sys, { name: `AI provider staging verification ${stamp}`, slug, environment: "staging", adminUserId: adminUser.id });
    const admin = () => ctxOf(org.id, adminUser);
    const member = async (role: string, department: string) => {
      const u = await mkUser(department.toLowerCase());
      const [m] = await p.db.withSystem("staging_verify.member", (tx) => tx.insert(memberships).values({ organizationId: org.id, userId: u.id, status: "active", joinedAt: new Date(), department }).returning());
      await p.rbac.roles.grantInternal(sysCtx(org.id), m!.id, role);
      return () => ctxOf(org.id, u);
    };
    const hr = await member("standard_user", "HR");
    const eng = await member("standard_user", "Engineering");
    // Full prompt retention is the strictest setting for redaction: stored requests must be redacted too.
    await p.organizations.updateRetention(admin(), { aiPromptRetention: "full" });
    for (const m of ["knowledge_verification", ...(opts.enableDataSecurity === false ? [] : ["data_security"]), "ai_operations"]) await p.modules.enable(admin(), m);

    const provider = await p.ai.configureProvider(admin(), { key: STAGING_PROVIDER_KEY, name: "Anthropic (staging)", kind: "anthropic", apiKey: opts.apiKey, config: { refusalFallback: "default", ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}) } });
    for (const m of catalog) {
      const price = prices[m.modelKey]!;
      await p.ai.upsertModel(admin(), provider.id, { modelKey: m.modelKey, displayName: m.displayName, capabilities: m.capabilities, contextWindow: m.contextWindow, maxOutputTokens: m.maxOutputTokens, inputCostPerMtok: price.input, outputCostPerMtok: price.output, tier: m.tier, maxDataClassification: m.maxDataClassification });
    }
    const ops = aiOpsService(p);
    // Every request in this org must go to the staging provider (never the platform sandbox or platform key).
    await ops.savePolicy(admin(), null, { name: "Staging: staging provider only", priority: 100, enforcement: "enforced", match: {}, rules: { allowedProviders: [STAGING_PROVIDER_KEY] } });
    log(`staging org ${slug} (${org.id}); provider ${STAGING_PROVIDER_KEY} → ${baseUrl}`);

    // ── 1. Grounding and citations ─────────────────────────────────────────
    {
      const a: Assertion[] = [];
      const kb = knowledgeService(p);
      const policies = await kb.createSource(admin(), { name: "Company policies", authority: "authoritative", ownerUserId: adminUser.id });
      const hrSource = await kb.createSource(admin(), { name: "HR handbook", authority: "preferred", defaultPrincipals: ["dept:hr"], ownerUserId: adminUser.id });
      for (const d of [DOCS.travel, DOCS.equipment, DOCS.payrollContact]) await kb.ingestDocument(admin(), { sourceId: policies.id, ...d });
      await kb.ingestDocument(admin(), { sourceId: hrSource.id, ...DOCS.compensation });

      const ask = async (label: string, who: () => TenantContext, question: string) => {
        const r = await observe(() => kb.ask(who(), { question }));
        if (r.error) throw r.error;
        const answer = r.value!;
        const [row] = await p.db.withSystem("staging_verify.answer", (tx) => tx.select({ runId: knowledgeAnswers.aiRunId }).from(knowledgeAnswers).where(eq(knowledgeAnswers.id, answer.answerId)));
        // Only runs that reached the provider are billable; DLP-held runs (e.g. salary data awaiting approval) are not.
        if (row?.runId && r.calls.length) ledger.push({ label, runId: row.runId, calls: r.calls });
        return { answer, calls: r.calls };
      };
      const grounded = (label: string, ans: Awaited<ReturnType<typeof ask>>["answer"], mustContain: string[]) => {
        const text = ans.response ?? "";
        const retrieved = new Set(ans.citations.map((c) => c.marker));
        const markers = [...text.matchAll(MARKER)].map((m) => m[1]!);
        const corpus = ans.citations.map((c) => c.excerpt).join(" ").replace(/,/g, "");
        a.push({ name: `${label}: generated by the provider (mode "generative")`, passed: ans.mode === "generative", observed: { mode: ans.mode, note: ans.modeNote } });
        a.push({ name: `${label}: answer contains the sourced facts ${mustContain.join(", ")}`, passed: mustContain.every((f) => text.includes(f)), observed: text });
        a.push({ name: `${label}: cites at least one source marker`, passed: markers.length > 0, observed: markers });
        a.push({ name: `${label}: every cited marker is a retrieved passage`, passed: markers.every((m) => retrieved.has(m)), observed: { cited: markers, retrieved: [...retrieved] } });
        a.push({ name: `${label}: every claim is verified against the sources`, passed: ans.claims.length > 0 && ans.claims.every((c) => c.status === "VERIFIED" || c.status === "PARTIALLY_VERIFIED"), observed: ans.claims.map((c) => ({ status: c.status, cited: c.cited, text: c.text })) });
        a.push({ name: `${label}: every important claim carries a citation`, passed: ans.claims.filter((c) => c.important).every((c) => c.cited.length > 0), observed: ans.claims.filter((c) => c.important && !c.cited.length).map((c) => c.text) });
        a.push({ name: `${label}: no figure in the answer is missing from the sources`, passed: numbersIn(text).every((n) => corpus.includes(n)), observed: numbersIn(text).filter((n) => !corpus.includes(n)) });
        a.push({ name: `${label}: verification did not fail`, passed: !ans.verificationFailed, observed: { confidence: ans.confidence.level, summary: ans.confidence.summary } });
      };

      const q1 = await ask("grounding.per_diem", eng, "What is the meal per diem for Vantrel business travel?");
      grounded("Q1 per diem", q1.answer, ["73"]);
      a.push({ name: "Q1: cites the travel policy", passed: q1.answer.citations.some((c) => c.cited && c.title === DOCS.travel.title), observed: q1.answer.citations.filter((c) => c.cited).map((c) => c.title) });

      const q2 = await ask("grounding.laptop", eng, "How often do Vantrel engineers get a laptop refresh?");
      grounded("Q2 laptop refresh", q2.answer, ["30"]);

      // Bait: the sources hold a domestic per diem only. A grounded answer must not invent an international figure.
      const q3 = await ask("grounding.bait", eng, "What is the Vantrel meal per diem for international travel to Japan, in yen?");
      const q3text = q3.answer.response ?? "";
      const corpus3 = q3.answer.citations.map((c) => c.excerpt).join(" ").replace(/,/g, "");
      a.push({ name: "Q3 (not in sources): no invented figures", passed: numbersIn(q3text).every((n) => corpus3.includes(n)), observed: q3text });
      a.push({ name: "Q3 (not in sources): no unsupported important claims", passed: !q3.answer.claims.some((c) => c.important && (c.status === "UNSUPPORTED" || c.status === "CONTRADICTED")), observed: q3.answer.claims.map((c) => ({ status: c.status, text: c.text })) });

      const q4 = await ask("grounding.unanswerable", eng, "What is the zyxquorbl submarine maintenance schedule?");
      a.push({ name: "Q4 (nothing retrieved): says no approved information answers it", passed: q4.answer.mode === "none" && /No approved information/.test(q4.answer.response ?? ""), observed: q4.answer.response });
      a.push({ name: "Q4 (nothing retrieved): the provider is not called", passed: q4.calls.length === 0, observed: q4.calls.length });

      const q5 = await ask("grounding.permissions_denied", eng, "What is the Vantrel level 5 salary band?");
      a.push({ name: "Q5 (HR-only document, Engineering user): HR content never reaches the provider", passed: !sent(q5.calls).includes(HR_SECRET) && !sent(q5.calls).includes(HR_FIGURE), observed: { providerCalls: q5.calls.length } });
      a.push({ name: "Q5: HR content is not in the answer", passed: !(q5.answer.response ?? "").includes(HR_FIGURE), observed: q5.answer.response });
      const q6 = await ask("grounding.permissions_allowed", hr, "What is the Vantrel level 5 salary band?");
      a.push({ name: "Q6 (control, HR user): the same question is answered from the HR document", passed: (q6.answer.response ?? "").includes(HR_FIGURE) && q6.answer.citations.some((c) => c.title === DOCS.compensation.title), observed: { response: q6.answer.response, mode: q6.answer.mode, note: q6.answer.modeNote } });

      checks.push({ id: "grounding", title: "Answers are grounded and cited correctly", passed: a.every((x) => x.passed), assertions: a });
      log(`grounding: ${a.filter((x) => x.passed).length}/${a.length}`);
    }

    // ── 3. Redaction never reaches the provider ─────────────────────────────
    {
      const a: Assertion[] = [];
      const exec = (content: string, useCase = "staging.dlp") => observe(() => p.ai.execute(admin(), { moduleId: "core", useCase, messages: [{ role: "user", content }], maxTokens: 200 }));
      const variants = (v: string) => [v, v.replace(/[\s-]/g, "")];
      const leaked = (calls: WireExchange[], values: string[]) => values.flatMap(variants).filter((v) => sent(calls).includes(v));

      const r1 = await exec(`Customer SSN ${SSN} and card ${CARD} — draft a short, polite reply confirming we received their documents.`);
      if (r1.value) ledger.push({ label: "redaction.redact", runId: r1.value.runId, calls: r1.calls });
      a.push({ name: "SSN + card: request is allowed after redaction", passed: !!r1.value && r1.value.policy.decision === "ALLOW" && r1.calls.length > 0, observed: r1.error ? String((r1.error as Error).message) : r1.value?.policy });
      a.push({ name: "SSN + card: raw values (any formatting) are absent from every request sent to the provider", passed: leaked(r1.calls, [SSN, CARD]).length === 0, observed: leaked(r1.calls, [SSN, CARD]) });
      a.push({ name: "SSN + card: the provider received the masked form instead", passed: sent(r1.calls).includes("***-**-7891"), observed: sent(r1.calls).match(/\*{3}-\*{2}-\d{4}/g) });

      const r2 = await exec(`Deploy the service with access key ${AWS_KEY} please.`);
      a.push({ name: "AWS access key: blocked with POLICY_DENIED", passed: (r2.error as { code?: string } | undefined)?.code === "POLICY_DENIED", observed: (r2.error as { code?: string } | undefined)?.code ?? "allowed" });
      a.push({ name: "AWS access key: no request reaches the provider", passed: r2.calls.length === 0, observed: r2.calls.length });

      const r3 = await exec("employee,department,salary,net pay\nJane Example,Finance,98000,6120\nSam Example,Ops,87000,5480");
      a.push({ name: "Payroll export: held for approval (APPROVAL_REQUIRED)", passed: (r3.error as { code?: string } | undefined)?.code === "APPROVAL_REQUIRED", observed: (r3.error as { code?: string } | undefined)?.code ?? "allowed" });
      a.push({ name: "Payroll export: no request reaches the provider while pending", passed: r3.calls.length === 0, observed: r3.calls.length });

      // A sensitive value inside a knowledge document: retrieval finds it, DLP must strip it before the model sees the passage.
      const kb = knowledgeService(p);
      const r4 = await observe(() => kb.ask(eng(), { question: "Who is the escalation contact for Vantrel payroll disputes?" }));
      if (r4.value) {
        const [row] = await p.db.withSystem("staging_verify.answer", (tx) => tx.select({ runId: knowledgeAnswers.aiRunId }).from(knowledgeAnswers).where(eq(knowledgeAnswers.id, r4.value!.answerId)));
        if (row?.runId && r4.calls.length) ledger.push({ label: "redaction.knowledge", runId: row.runId, calls: r4.calls });
      }
      a.push({ name: "Knowledge passage with an SSN: retrieval found the document and called the provider", passed: r4.calls.length > 0 && !!r4.value?.citations.some((c) => c.title === DOCS.payrollContact.title), observed: { calls: r4.calls.length, error: r4.error ? String((r4.error as Error).message) : null } });
      a.push({ name: "Knowledge passage with an SSN: the SSN never reaches the provider", passed: leaked(r4.calls, [KB_SSN]).length === 0, observed: leaked(r4.calls, [KB_SSN]) });

      const stored = JSON.stringify(await p.db.withSystem("staging_verify.runs", (tx) => tx.execute(sql`select request, response, policy_reasons, error_message from ai_runs where organization_id = ${org.id}`)));
      const storedLeaks = [SSN, CARD, AWS_KEY, KB_SSN].flatMap(variants).filter((v) => stored.includes(v));
      a.push({ name: "No raw sensitive value is stored in the AI run log (full prompt retention)", passed: storedLeaks.length === 0, observed: storedLeaks });
      const allLeaks = [SSN, CARD, AWS_KEY, KB_SSN].flatMap(variants).filter((v) => sent(wire.exchanges).includes(v));
      a.push({ name: "Across the whole run, no raw sensitive value appears in any provider request", passed: allLeaks.length === 0, observed: allLeaks });

      const events = opts.enableDataSecurity === false ? [] : await dataSecurityService(p).listDlpEvents(admin());
      a.push({ name: "DLP decisions are logged against the staging provider destination", passed: events.some((e) => e.decision === "REDACT" && e.destination === `platform:${STAGING_PROVIDER_KEY}`) && events.some((e) => e.decision === "BLOCK"), observed: events.slice(0, 6).map((e) => ({ decision: e.decision, destination: e.destination })) });

      checks.push({ id: "redaction", title: "Redacted data never reaches the provider", passed: a.every((x) => x.passed), assertions: a });
      log(`redaction: ${a.filter((x) => x.passed).length}/${a.length}`);
    }

    // ── 4. A routing policy with no qualifying model fails cleanly ─────────
    {
      const a: Assertion[] = [];
      const runCount = async (useCase: string) => (await p.db.withSystem("staging_verify.count", (tx) => tx.select({ n: sql<number>`count(*)::int` }).from(aiRuns).where(and(eq(aiRuns.organizationId, org.id), eq(aiRuns.useCase, useCase)))))[0]!.n;
      const costSoFar = async () => Number((await p.db.withSystem("staging_verify.cost", (tx) => tx.select({ n: sql<string>`coalesce(sum(${usageEvents.quantity}), 0)` }).from(usageEvents).where(and(eq(usageEvents.organizationId, org.id), eq(usageEvents.metric, "ai.cost")))))[0]!.n);

      const eu = await ops.savePolicy(admin(), null, { name: "Legal: EU-hosted models only", priority: 1, enforcement: "enforced", match: { useCases: ["legal.*"] }, rules: { allowedProviders: ["eu-sovereign"] }, regulatoryNote: "EU residency" });
      a.push({ name: "Saving the policy warns that no enabled model qualifies", passed: /No enabled model/i.test(eu.warning ?? ""), observed: eu.warning });
      const cap = await ops.savePolicy(admin(), null, { name: "Media: audio transcription", priority: 2, enforcement: "enforced", match: { useCases: ["media.*"] }, rules: { requiredCapabilities: ["audio_transcription"] } });

      const costBefore = await costSoFar();
      for (const [useCase, why] of [["legal.contract_review", "provider not allowed"], ["media.transcribe", "missing capability"]] as const) {
        const r = await observe(() => p.ai.execute(admin(), { moduleId: "core", useCase, messages: [{ role: "user", content: "Review this clause: the supplier may terminate on 30 days' notice." }], maxTokens: 200 }));
        const err = r.error as { code?: string; status?: number; message?: string; retryable?: boolean; details?: unknown; stack?: string } | undefined;
        const body = JSON.stringify({ code: err?.code, message: err?.message, details: err?.details });
        a.push({ name: `${useCase} (${why}): fails with NOT_CONFIGURED (HTTP ${err?.status ?? "?"})`, passed: err?.code === "NOT_CONFIGURED" && err.status === 501 && !r.value, observed: { code: err?.code, status: err?.status, message: err?.message } });
        a.push({ name: `${useCase}: the error is clean — a fixed message, not retryable, no stack, credential or internal detail in what clients see`, passed: err?.message === "No enabled AI model satisfies this request." && err.retryable === false && !/\bat \S+ \(|node_modules|sk-ant|postgres:\/\//.test(body), observed: body.slice(0, 400) });
        a.push({ name: `${useCase}: no request reaches the provider`, passed: r.calls.length === 0, observed: r.calls.length });
        a.push({ name: `${useCase}: nothing is recorded as a run or billed`, passed: (await runCount(useCase)) === 0, observed: await runCount(useCase) });
      }
      a.push({ name: "No cost is metered for the failed requests", passed: (await costSoFar()) === costBefore, observed: { before: costBefore, after: await costSoFar() } });

      const control = await observe(() => p.ai.execute(admin(), { moduleId: "core", useCase: "general.summary", messages: [{ role: "user", content: "Say hello in five words." }], maxTokens: 100 }));
      if (control.value) ledger.push({ label: "fail_closed.control", runId: control.value.runId, calls: control.calls });
      a.push({ name: "Tasks outside the policy keep working", passed: !!control.value && control.calls.length >= 1, observed: control.error ? String((control.error as Error).message) : control.value?.servedModel });

      // A module caller degrades instead of erroring: Knowledge falls back to quoting the sources.
      const kbPolicy = await ops.savePolicy(admin(), null, { name: "Knowledge: EU-hosted models only", priority: 1, enforcement: "enforced", match: { useCases: ["knowledge.answer"] }, rules: { allowedProviders: ["eu-sovereign"] } });
      const kb = knowledgeService(p);
      const k = await observe(() => kb.ask(eng(), { question: "What is the meal per diem for Vantrel business travel?" }));
      a.push({ name: "Knowledge under a no-model policy: answers extractively and says why", passed: k.value?.mode === "extractive" && /No AI model is configured/.test(k.value.modeNote ?? ""), observed: { mode: k.value?.mode, note: k.value?.modeNote, error: k.error ? String((k.error as Error).message) : null } });
      a.push({ name: "Knowledge under a no-model policy: no request reaches the provider", passed: k.calls.length === 0, observed: k.calls.length });
      for (const id of [eu.id, cap.id, kbPolicy.id]) await ops.savePolicy(admin(), id, { status: "disabled" });

      checks.push({ id: "fail_closed", title: "A routing policy with no qualifying model fails cleanly", passed: a.every((x) => x.passed), assertions: a });
      log(`fail-closed: ${a.filter((x) => x.passed).length}/${a.length}`);
    }

    // ── 2. Costs: recorded = provider-reported × contract price, nothing unmetered ──
    const rows: CostRow[] = [];
    {
      const a: Assertion[] = [];
      for (const model of probeModels) {
        const r = await observe(() => p.ai.execute(admin(), { moduleId: "core", useCase: "staging.cost_probe", provider: STAGING_PROVIDER_KEY, model, messages: [{ role: "user", content: "In one sentence, what is a ledger?" }], maxTokens: 300 }));
        if (r.value) ledger.push({ label: `costs.probe.${model}`, runId: r.value.runId, calls: r.calls });
        a.push({ name: `${model}: probe request succeeded`, passed: !!r.value, observed: r.error ? String((r.error as Error).message) : r.value?.servedModel });
      }

      for (const entry of ledger) {
        const [run] = await p.db.withSystem("staging_verify.run", (tx) => tx.select().from(aiRuns).where(eq(aiRuns.id, entry.runId)));
        const meters = await p.db.withSystem("staging_verify.meters", (tx) => tx.select().from(usageEvents).where(and(eq(usageEvents.organizationId, org.id), sql`${usageEvents.dedupeKey} like ${`${entry.runId}:%`}`)));
        const ok = entry.calls.filter((c) => c.status >= 200 && c.status < 300);
        const last = ok[ok.length - 1];
        const res = last ? (JSON.parse(last.responseBody) as { id?: string; model?: string; usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null } }) : {};
        const u = res.usage ?? {};
        const served = res.model ?? "";
        const price = prices[served];
        const wireIn = u.input_tokens ?? 0;
        const wireOut = u.output_tokens ?? 0;
        const cacheW = u.cache_creation_input_tokens ?? 0;
        const cacheR = u.cache_read_input_tokens ?? 0;
        const expected = price ? Math.round(((wireIn * price.input + wireOut * price.output) / 1e6) * 1e6) / 1e6 : NaN;
        const metered = (k: string) => Number(meters.find((m) => m.metric === k)?.quantity ?? NaN);
        const row: CostRow = {
          runId: entry.runId, label: entry.label, useCase: run?.useCase ?? "", providerRequestId: last?.requestId ?? null, messageId: res.id ?? null, requestedModel: run?.modelKey ?? "", servedModel: served,
          wireInputTokens: wireIn, wireCacheCreationTokens: cacheW, wireCacheReadTokens: cacheR, wireOutputTokens: wireOut,
          recordedInputTokens: run?.inputTokens ?? 0, recordedOutputTokens: run?.outputTokens ?? 0, recordedCostUsd: Number(run?.estimatedCostUsd ?? NaN), meteredCostUsd: metered("ai.cost"), expectedCostUsd: expected, at: last?.at ?? "",
        };
        rows.push(row);
        const id = `${entry.label} (run ${entry.runId.slice(0, 8)})`;
        a.push({ name: `${id}: exactly one successful provider response`, passed: ok.length === 1, observed: entry.calls.map((c) => c.status) });
        a.push({ name: `${id}: recorded tokens equal provider-reported tokens`, passed: row.recordedInputTokens === wireIn && row.recordedOutputTokens === wireOut, observed: { recorded: [row.recordedInputTokens, row.recordedOutputTokens], provider: [wireIn, wireOut] } });
        a.push({ name: `${id}: no prompt-cache tokens (the metering does not price cache reads/writes)`, passed: cacheW === 0 && cacheR === 0, observed: { cacheW, cacheR } });
        a.push({ name: `${id}: served model ${served || "?"} is recorded and has a contract price`, passed: !!price && (run?.metadata as { servedModel?: string } | undefined)?.servedModel === served, observed: { requested: row.requestedModel, served, recorded: (run?.metadata as { servedModel?: string } | undefined)?.servedModel } });
        a.push({ name: `${id}: recorded cost = provider tokens × contract price`, passed: Math.abs(row.recordedCostUsd - expected) < 1e-6, observed: { recorded: row.recordedCostUsd, expected } });
        a.push({ name: `${id}: metered usage (runs, tokens, cost) matches the run`, passed: metered("ai.runs") === 1 && metered("ai.input_tokens") === wireIn && metered("ai.output_tokens") === wireOut && Math.abs(row.meteredCostUsd - expected) < 1e-6, observed: Object.fromEntries(meters.map((m) => [m.metric, Number(m.quantity)])) });
      }

      // Nothing billed goes unrecorded: every successful provider response maps to exactly one ledger run.
      const billed = wire.exchanges.filter((c) => c.status >= 200 && c.status < 300);
      const accounted = new Set(ledger.flatMap((l) => l.calls.filter((c) => c.status >= 200 && c.status < 300).map((c) => c.seq)));
      a.push({ name: "Every successful provider request is accounted to exactly one recorded run", passed: billed.length === accounted.size && billed.every((c) => accounted.has(c.seq)) && ledger.length === new Set(ledger.map((l) => l.runId)).size, observed: { providerSuccesses: billed.length, accounted: accounted.size, runs: ledger.length } });
      const runsTotal = (await p.db.withSystem("staging_verify.total", (tx) => tx.select({ n: sql<string>`coalesce(sum(${aiRuns.estimatedCostUsd}), 0)` }).from(aiRuns).where(eq(aiRuns.organizationId, org.id))))[0]!.n;
      const meterTotal = (await p.db.withSystem("staging_verify.total", (tx) => tx.select({ n: sql<string>`coalesce(sum(${usageEvents.quantity}), 0)` }).from(usageEvents).where(and(eq(usageEvents.organizationId, org.id), eq(usageEvents.metric, "ai.cost")))))[0]!.n;
      const expectedTotal = rows.reduce((s, r) => s + r.expectedCostUsd, 0);
      a.push({ name: "Org totals: run log = usage metering = Σ provider tokens × contract price", passed: Math.abs(Number(runsTotal) - expectedTotal) < 1e-5 && Math.abs(Number(meterTotal) - expectedTotal) < 1e-5, observed: { runLog: Number(runsTotal), metering: Number(meterTotal), expected: Math.round(expectedTotal * 1e6) / 1e6 } });

      checks.push({ id: "costs", title: "Recorded costs match what the provider bills", passed: a.every((x) => x.passed), assertions: a });
      log(`costs: ${a.filter((x) => x.passed).length}/${a.length}`);
    }

    const byModel: VerificationReport["costs"]["totals"]["byModel"] = {};
    for (const r of rows) {
      const t = (byModel[r.servedModel] ??= { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
      t.requests += 1;
      t.inputTokens += r.wireInputTokens;
      t.outputTokens += r.wireOutputTokens;
      t.costUsd = Math.round((t.costUsd + r.expectedCostUsd) * 1e6) / 1e6;
    }
    const order = ["grounding", "costs", "redaction", "fail_closed"];
    checks.sort((x, y) => order.indexOf(x.id) - order.indexOf(y.id));
    return {
      mode: opts.mode,
      startedAt,
      finishedAt: new Date().toISOString(),
      organization: { id: org.id, slug, name: org.name },
      provider: { key: STAGING_PROVIDER_KEY, baseUrl },
      passed: checks.length === 4 && checks.every((c) => c.passed),
      checks,
      costs: { rows, totals: { byModel, costUsd: Math.round(rows.reduce((s, r) => s + r.expectedCostUsd, 0) * 1e6) / 1e6 }, providerRequests: wire.exchanges.length },
    };
  } finally {
    wire.restore();
  }
}

// ── Output ───────────────────────────────────────────────────────────────────
const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function costsCsv(r: VerificationReport): string {
  const cols: Array<keyof CostRow> = ["at", "runId", "label", "useCase", "providerRequestId", "messageId", "requestedModel", "servedModel", "wireInputTokens", "wireCacheCreationTokens", "wireCacheReadTokens", "wireOutputTokens", "recordedInputTokens", "recordedOutputTokens", "expectedCostUsd", "recordedCostUsd", "meteredCostUsd"];
  return [cols.join(","), ...r.costs.rows.map((row) => cols.map((c) => csvCell(row[c])).join(","))].join("\n") + "\n";
}

export function reportMarkdown(r: VerificationReport, extra = ""): string {
  const lines = [
    `# AI provider staging verification — ${r.passed ? "PASSED" : "FAILED"}`,
    "",
    `- Mode: **${r.mode}**${r.mode === "mock" ? " (local Messages-API stand-in; no real provider was called)" : ""}`,
    `- Organization: ${r.organization.name} (\`${r.organization.slug}\`, ${r.organization.id})`,
    `- Provider: \`${r.provider.key}\` → ${r.provider.baseUrl}`,
    `- Window: ${r.startedAt} → ${r.finishedAt}`,
    `- Provider requests: ${r.costs.providerRequests}; recorded cost: $${r.costs.totals.costUsd.toFixed(6)}`,
    "",
    "| Check | Result | Assertions |",
    "|---|---|---|",
    ...r.checks.map((c) => `| ${c.title} | ${c.passed ? "✅ pass" : "❌ FAIL"} | ${c.assertions.filter((x) => x.passed).length}/${c.assertions.length} |`),
    "",
    "## Cost by model",
    "",
    "| Model | Requests | Input tokens | Output tokens | Cost (USD) |",
    "|---|---:|---:|---:|---:|",
    ...Object.entries(r.costs.totals.byModel).map(([m, t]) => `| ${m} | ${t.requests} | ${t.inputTokens} | ${t.outputTokens} | ${t.costUsd.toFixed(6)} |`),
    "",
    ...r.checks.flatMap((c) => [`## ${c.title}`, "", ...c.assertions.map((x) => `- ${x.passed ? "✅" : "❌"} ${x.name}${x.passed ? "" : `\n  - observed: \`${JSON.stringify(x.observed).slice(0, 600).replace(/`/g, "'")}\``}`), ""]),
  ];
  return lines.join("\n") + (extra ? `\n${extra}\n` : "");
}
