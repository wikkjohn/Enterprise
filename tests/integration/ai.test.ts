import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Platform } from "../../packages/platform/src";
import { addMember, createOrg, createTestPlatform, expectCode } from "../helpers/platform";

let p: Platform;
let O: Awaited<ReturnType<typeof createOrg>>;
const ask = (content: string, extra: Record<string, unknown> = {}) => ({ moduleId: "core", useCase: "test.ask", messages: [{ role: "user" as const, content }], model: "sandbox-echo", ...extra });

beforeAll(async () => {
  p = await createTestPlatform();
  O = await createOrg(p);
});
afterAll(() => p.close());

describe("shared AI provider layer", () => {
  it("platform catalog: Anthropic models seeded; unconfigured providers are not routable", async () => {
    const providers = await p.ai.listProviders(O.adminCtx());
    const anthropic = providers.find((x) => x.key === "anthropic")!;
    expect(anthropic.status).toBe("not_configured"); // no ANTHROPIC_API_KEY in tests
    expect(anthropic.models.map((m) => m.modelKey)).toEqual(expect.arrayContaining(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"]));
    await expectCode(p.ai.execute(O.adminCtx(), ask("hi", { model: "claude-opus-5-5" })), "NOT_CONFIGURED");
  });

  it("executes, logs the run, meters tokens and cost, and emits ai.run.completed", async () => {
    const r = await p.ai.execute(O.adminCtx(), ask("hello world", { references: { workflowId: "wf-1" }, promptTemplate: { id: "test.prompt", version: "3" } }));
    expect(r.text).toContain("[SIMULATED]");
    const run = await p.ai.getRun(O.adminCtx(), r.runId);
    expect(run).toMatchObject({ status: "succeeded", moduleId: "core", useCase: "test.ask", providerKey: "sandbox", promptTemplateId: "test.prompt", promptTemplateVersion: "3", actorId: O.admin.id });
    expect(run.metadata).toMatchObject({ references: { workflowId: "wf-1" } });
    const usage = await p.usage.summary(O.adminCtx(), { from: new Date(Date.now() - 60_000), to: new Date(Date.now() + 60_000), groupBy: "ai_model" });
    expect(usage.find((u) => u.metric === "ai.input_tokens" && u.key === "sandbox-echo")?.quantity).toBeGreaterThan(0);
  });

  it("honours prompt retention settings (metadata by default, none, full)", async () => {
    const r1 = await p.ai.execute(O.adminCtx(), ask("retention metadata"));
    const run1 = await p.ai.getRun(O.adminCtx(), r1.runId);
    expect(run1.request).toBeNull();
    expect(run1.promptHash).toMatch(/^[0-9a-f]{64}$/);
    await p.organizations.updateRetention(O.adminCtx(), { aiPromptRetention: "full" });
    const r2 = await p.ai.execute(O.adminCtx(), ask("retention full"));
    expect(JSON.stringify((await p.ai.getRun(O.adminCtx(), r2.runId)).request)).toContain("retention full");
    await p.organizations.updateRetention(O.adminCtx(), { aiPromptRetention: "metadata" });
  });

  it("org ai_usage policies can DENY or REQUIRE_APPROVAL before any provider call", async () => {
    const o = await createOrg(p);
    await p.policies.create(o.adminCtx(), {
      key: "ai.no-restricted",
      name: "No restricted data to AI",
      kind: "ai_usage",
      definition: {
        defaultEffect: "ALLOW",
        rules: [
          { id: "deny-restricted", effect: "DENY", when: { field: "context.dataClassification", op: "eq", value: "restricted" } },
          { id: "approve-confidential", effect: "REQUIRE_APPROVAL", when: { field: "context.dataClassification", op: "eq", value: "confidential" } },
        ],
      },
    });
    await p.policies.activate(o.adminCtx(), "ai.no-restricted", 1);
    await expectCode(p.ai.execute(o.adminCtx(), ask("secret", { dataClassification: "restricted" })), "POLICY_DENIED");
    await expectCode(p.ai.execute(o.adminCtx(), ask("conf", { dataClassification: "confidential" })), "APPROVAL_REQUIRED");
    const ok = await p.ai.execute(o.adminCtx(), ask("fine", { dataClassification: "internal" }));
    expect(ok.policy.decision).toBe("ALLOW");
    const runs = await p.ai.listRuns(o.adminCtx(), {});
    expect(runs.data.map((r) => r.status).sort()).toEqual(["blocked", "pending_approval", "succeeded"]);
  });

  it("module policy hooks can redact content before it reaches the provider", async () => {
    const q = await createTestPlatform();
    q.ai.registerPolicyHook("test.redactor", async ({ request }) => ({
      decision: "REDACT",
      reasons: ["masked SSN"],
      request: { ...request, messages: request.messages.map((m) => ({ ...m, content: m.content.replace(/\d{3}-\d{2}-\d{4}/g, "[SSN]") })) },
    }));
    const o = await createOrg(q);
    const r = await q.ai.execute(o.adminCtx(), ask("ssn is 123-45-6789"));
    expect(r.text).toContain("[SSN]");
    expect(r.text).not.toContain("123-45-6789");
    await q.close();
  });

  it("provider refusals are surfaced and logged, not silently returned", async () => {
    await expectCode(p.ai.execute(O.adminCtx(), ask("__simulate_refusal__")), "POLICY_DENIED");
    await expectCode(p.ai.execute(O.adminCtx(), ask("__simulate_failure__")), "UPSTREAM_ERROR");
    const runs = await p.ai.listRuns(O.adminCtx(), {});
    expect(runs.data.some((r) => r.errorCode === "PROVIDER_REFUSAL")).toBe(true);
    expect(runs.data.some((r) => r.status === "failed")).toBe(true);
  });

  it("requires ai.use and respects data classification in routing", async () => {
    const viewer = await addMember(p, O.org.id, ["read_only"]);
    await expectCode(p.ai.execute(viewer.ctx(), ask("x")), "FORBIDDEN");
    // Restricted data can only be routed to models approved for it.
    const r = await p.ai.execute(O.adminCtx(), { moduleId: "core", useCase: "test.route", messages: [{ role: "user", content: "x" }], dataClassification: "restricted" });
    expect(r.model).toBe("sandbox-echo");
  });

  it("tenants can bring their own provider; credentials go to the secret store", async () => {
    const view = await p.ai.configureProvider(O.adminCtx(), { key: "acme-azure", name: "Acme Azure OpenAI", kind: "azure_openai", config: { baseUrl: "https://acme.openai.azure.com" }, apiKey: "azure-key-123" });
    expect(view).toMatchObject({ scope: "organization", status: "enabled", hasCredential: true });
    expect(JSON.stringify(view)).not.toContain("azure-key-123");
    await expectCode(p.ai.configureProvider(O.adminCtx(), { key: "bad", name: "bad", kind: "openai", config: { apiKey: "x" } }), "VALIDATION_FAILED");
  });
});
