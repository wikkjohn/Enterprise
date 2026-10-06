/**
 * Real-provider staging verification. See docs/STAGING-AI-VERIFICATION.md.
 *
 *   pnpm verify:ai --live                 # needs ANTHROPIC_API_KEY; makes ~15 small, billed Claude API calls
 *   pnpm verify:ai --mock                 # no key: local Messages-API stand-in (tests the harness itself)
 *   pnpm verify:ai --reconcile <report.json>
 *                                         # needs ANTHROPIC_ADMIN_KEY: compares a live run with Anthropic's usage report
 *
 * Options: --out <dir>  --prices <prices.json>  --models claude-haiku-4-5,claude-sonnet-5-5
 * prices.json: { "claude-opus-5-5": { "input": 4, "output": 20 }, … } (USD per 1M tokens, your contract prices)
 *
 * Exit code 0 only when every check passes.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODULE_DEFINITIONS } from "../packages/module-catalog/src";
import { createPlatform, loadEnv } from "../packages/platform/src";
import { costsCsv, reportMarkdown, runStagingVerification, type ModelPrice, type VerificationReport } from "./staging-verify/harness";
import { MOCK_ADMIN_KEY, MOCK_API_KEY, startMockAnthropic } from "./staging-verify/mock-anthropic";
import { reconcileWithUsageReport } from "./staging-verify/reconcile";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const usage = () => {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]!.replace(/^\/\*\*?|^ \* ?/gm, ""));
  process.exit(2);
};

async function reconcile(path: string) {
  const adminKey = process.env.ANTHROPIC_ADMIN_KEY;
  if (!adminKey) {
    console.error("ANTHROPIC_ADMIN_KEY (an Admin API key, sk-ant-admin…) is required to read Anthropic's usage report.");
    process.exit(2);
  }
  const report = JSON.parse(readFileSync(path, "utf8")) as VerificationReport;
  if (report.mode !== "live") console.warn("Note: this report is from a mock run; Anthropic's usage report will not contain it.");
  const r = await reconcileWithUsageReport(report, { adminKey, apiKeyId: process.env.ANTHROPIC_RECONCILE_API_KEY_ID });
  for (const a of r.assertions) console.log(`${a.passed ? "✔" : "✘"} ${a.name}${a.passed ? "" : `\n    ${JSON.stringify(a.observed)}`}`);
  if (!process.env.ANTHROPIC_RECONCILE_API_KEY_ID) console.log("• Not scoped to an API key: other traffic in the same minutes will show up as a mismatch. Set ANTHROPIC_RECONCILE_API_KEY_ID.");
  console.log(r.passed ? "\nRecorded usage matches Anthropic's usage report." : "\nRecorded usage does NOT match Anthropic's usage report.");
  process.exit(r.passed ? 0 : 1);
}

async function main() {
  const reconcilePath = value("reconcile");
  if (reconcilePath) return reconcile(reconcilePath);
  const live = flag("live");
  const mock = flag("mock");
  if (live === mock) usage();

  const env = loadEnv();
  if (env.APP_ENV === "production") {
    console.error("Refusing to run against a production environment: this creates a verification organization and test data.");
    process.exit(1);
  }
  const apiKey = live ? process.env.ANTHROPIC_API_KEY : MOCK_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is not set. Add it to the environment (a dedicated staging key is best) or use --mock.");
    process.exit(2);
  }
  const server = mock ? await startMockAnthropic() : null;
  const prices = value("prices") ? (JSON.parse(readFileSync(value("prices")!, "utf8")) as Record<string, ModelPrice>) : undefined;
  const models = value("models")?.split(",").map((m) => m.trim()).filter(Boolean);
  const out = value("out") ?? join("staging-verification", new Date().toISOString().replace(/[:.]/g, "-"));

  const p = createPlatform(env, { modules: MODULE_DEFINITIONS });
  await p.bootstrap();
  let report: VerificationReport;
  try {
    report = await runStagingVerification(p, { mode: live ? "live" : "mock", apiKey, baseUrl: server?.url, prices, models, log: (l) => console.log(`• ${l}`) });
  } finally {
    await p.close();
  }

  let extra = "";
  if (server) {
    // Exercise the usage-report reconciliation path against the stand-in.
    const r = await reconcileWithUsageReport(report, { adminKey: MOCK_ADMIN_KEY, baseUrl: server.url });
    extra = `## Usage-report reconciliation (mock)\n\n${r.assertions.map((a) => `- ${a.passed ? "✅" : "❌"} ${a.name}`).join("\n")}\n`;
    await server.close();
  } else {
    extra = [
      "## Reconciling with Anthropic",
      "",
      "1. In about five minutes, compare against Anthropic's own usage records:",
      `   \`ANTHROPIC_ADMIN_KEY=… ANTHROPIC_RECONCILE_API_KEY_ID=apikey_… pnpm verify:ai --reconcile ${join(out, "report.json")}\``,
      "2. For the invoice: in the Claude Console (Usage / Cost, filtered to the staging key and this window), the totals should equal the cost table above. `costs.csv` lists every request with its `request-id` for line-level checks.",
    ].join("\n");
  }

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(out, "report.md"), reportMarkdown(report, extra));
  writeFileSync(join(out, "costs.csv"), costsCsv(report));
  for (const c of report.checks) console.log(`${c.passed ? "✔" : "✘"} ${c.title} (${c.assertions.filter((a) => a.passed).length}/${c.assertions.length})`);
  console.log(`\n${report.passed ? "PASSED" : "FAILED"} — report: ${join(out, "report.md")}`);
  process.exit(report.passed ? 0 : 1);
}

await main();
