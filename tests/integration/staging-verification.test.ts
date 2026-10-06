import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runStagingVerification, type VerificationReport } from "../../scripts/staging-verify/harness";
import { MOCK_ADMIN_KEY, MOCK_API_KEY, startMockAnthropic, type MockFault } from "../../scripts/staging-verify/mock-anthropic";
import { reconcileWithUsageReport } from "../../scripts/staging-verify/reconcile";
import { createTestPlatform } from "../helpers/platform";

/**
 * The real-provider staging harness (scripts/verify-ai-provider.ts), run
 * against the local Messages-API stand-in. A clean provider must pass every
 * check, and each injected fault must be caught by the check that owns it.
 */
type P = Awaited<ReturnType<typeof createTestPlatform>>;
let p: P;

beforeAll(async () => {
  p = await createTestPlatform();
});
afterAll(() => p.close());

async function run(faults: MockFault[] = [], extra: { enableDataSecurity?: boolean } = {}) {
  const mock = await startMockAnthropic(faults);
  try {
    const report = await runStagingVerification(p, { mode: "mock", apiKey: MOCK_API_KEY, baseUrl: mock.url, ...extra });
    return { report, mock };
  } finally {
    await mock.close();
  }
}
const check = (r: VerificationReport, id: string) => r.checks.find((c) => c.id === id)!;
const failed = (r: VerificationReport, id: string) => check(r, id).assertions.filter((a) => !a.passed).map((a) => a.name);

describe("Staging verification harness", () => {
  it("passes all four checks against a well-behaved provider, with every billed request in the cost ledger", async () => {
    const { report, mock } = await run();
    for (const c of report.checks) expect(failed(report, c.id), c.title).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.organization.slug).toMatch(/^ai-staging-/);
    const billed = mock.requests.filter((r) => r.path === "/v1/messages").length;
    expect(report.costs.rows).toHaveLength(billed);
    expect(report.costs.rows.every((r) => r.providerRequestId?.startsWith("req_mock_"))).toBe(true);
    expect(Object.keys(report.costs.totals.byModel).sort()).toEqual(["claude-haiku-4-5", "claude-opus-5-5", "claude-sonnet-5-5"]);
  }, 60_000);

  it("reconciles against the usage report and flags a mismatch", async () => {
    const mock = await startMockAnthropic();
    try {
      const report = await runStagingVerification(p, { mode: "mock", apiKey: MOCK_API_KEY, baseUrl: mock.url, models: ["claude-haiku-4-5"] });
      expect((await reconcileWithUsageReport(report, { adminKey: MOCK_ADMIN_KEY, baseUrl: mock.url })).passed).toBe(true);
      const tampered = structuredClone(report);
      tampered.costs.totals.byModel["claude-haiku-4-5"]!.outputTokens -= 1;
      expect((await reconcileWithUsageReport(tampered, { adminKey: MOCK_ADMIN_KEY, baseUrl: mock.url })).passed).toBe(false);
    } finally {
      await mock.close();
    }
  }, 60_000);

  it("catches an ungrounded answer that cites a source for an invented figure", async () => {
    const { report } = await run(["ungrounded"]);
    expect(check(report, "grounding").passed).toBe(false);
    expect(failed(report, "grounding")).toEqual(expect.arrayContaining([expect.stringMatching(/Q1 per diem: answer contains the sourced facts/), expect.stringMatching(/Q1 per diem: no figure in the answer is missing from the sources/)]));
    expect(report.passed).toBe(false);
  }, 60_000);

  it("catches prompt-cache tokens the metering does not price, and attributes fallback-served requests to the serving model", async () => {
    const { report } = await run(["cache_tokens", "fallback"]);
    expect(failed(report, "costs").some((n) => /no prompt-cache tokens/.test(n))).toBe(true);
    const opus = report.costs.rows.find((r) => r.label === "costs.probe.claude-opus-5-5")!;
    expect(opus).toMatchObject({ requestedModel: "claude-opus-5-5", servedModel: "claude-sonnet-5-5" });
    expect(opus.recordedCostUsd).toBeCloseTo(opus.expectedCostUsd, 6);
    expect(failed(report, "costs").filter((n) => n.includes("costs.probe.claude-opus-5-5") && !/prompt-cache/.test(n))).toEqual([]);
  }, 60_000);

  it("catches sensitive data reaching the provider when DLP is not in the path", async () => {
    const { report } = await run([], { enableDataSecurity: false });
    expect(failed(report, "redaction")).toEqual(expect.arrayContaining([expect.stringMatching(/raw values .* are absent/), expect.stringMatching(/SSN never reaches the provider/), expect.stringMatching(/no raw sensitive value appears in any provider request/)]));
    expect(check(report, "fail_closed").passed).toBe(true);
  }, 60_000);
});
