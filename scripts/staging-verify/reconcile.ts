import { type Assertion, type VerificationReport } from "./harness";

/**
 * Reconciles a verification run against Anthropic's own usage records via
 * the Usage & Cost Admin API (GET /v1/organizations/usage_report/messages).
 * Needs an Admin API key (sk-ant-admin…), not the regular API key. Usage
 * appears about five minutes after a request completes, so run this a few
 * minutes after the verification run.
 *
 * Totals are compared per model over the run's time window. They match
 * exactly only when the API key used for the run carries no other traffic in
 * that window — use a dedicated key (or workspace) for staging verification
 * and pass its id as apiKeyId to scope the report to it.
 */
export interface ReconcileOptions {
  adminKey: string;
  /** Scope the usage report to this API key id (apikey_…). Strongly recommended. */
  apiKeyId?: string;
  baseUrl?: string;
}

interface UsageResult { model?: string | null; uncached_input_tokens?: number; cache_read_input_tokens?: number; cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }; output_tokens?: number }
interface UsagePage { data: Array<{ starting_at: string; ending_at: string; results: UsageResult[] }>; has_more?: boolean; next_page?: string | null }

const floorMinute = (iso: string) => new Date(Math.floor(Date.parse(iso) / 60_000) * 60_000).toISOString().replace(".000Z", "Z");
const ceilMinute = (iso: string) => new Date(Math.ceil(Date.parse(iso) / 60_000) * 60_000 + 60_000).toISOString().replace(".000Z", "Z");

export async function reconcileWithUsageReport(report: VerificationReport, opts: ReconcileOptions): Promise<{ passed: boolean; assertions: Assertion[]; provider: Record<string, { inputTokens: number; cacheTokens: number; outputTokens: number }> }> {
  const base = opts.baseUrl ?? "https://api.anthropic.com";
  const provider: Record<string, { inputTokens: number; cacheTokens: number; outputTokens: number }> = {};
  let page: string | null = null;
  do {
    const q = new URLSearchParams({ starting_at: floorMinute(report.startedAt), ending_at: ceilMinute(report.finishedAt), bucket_width: "1m", limit: "1440" });
    q.append("group_by[]", "model");
    if (opts.apiKeyId) q.append("api_key_ids[]", opts.apiKeyId);
    if (page) q.set("page", page);
    const res = await fetch(`${base}/v1/organizations/usage_report/messages?${q}`, { headers: { "x-api-key": opts.adminKey, "anthropic-version": "2023-06-01" } });
    if (!res.ok) throw new Error(`Usage report request failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as UsagePage;
    for (const bucket of body.data) {
      for (const r of bucket.results) {
        const t = (provider[r.model ?? "unknown"] ??= { inputTokens: 0, cacheTokens: 0, outputTokens: 0 });
        t.inputTokens += r.uncached_input_tokens ?? 0;
        t.cacheTokens += (r.cache_read_input_tokens ?? 0) + (r.cache_creation?.ephemeral_5m_input_tokens ?? 0) + (r.cache_creation?.ephemeral_1h_input_tokens ?? 0);
        t.outputTokens += r.output_tokens ?? 0;
      }
    }
    page = body.has_more ? (body.next_page ?? null) : null;
  } while (page);

  const ours = report.costs.totals.byModel;
  const assertions: Assertion[] = [];
  for (const model of new Set([...Object.keys(ours), ...Object.keys(provider)])) {
    const mine = ours[model] ?? { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const theirs = provider[model] ?? { inputTokens: 0, cacheTokens: 0, outputTokens: 0 };
    assertions.push({
      name: `${model}: Anthropic usage report tokens equal recorded tokens`,
      passed: theirs.inputTokens === mine.inputTokens && theirs.outputTokens === mine.outputTokens && theirs.cacheTokens === 0,
      observed: { recorded: { input: mine.inputTokens, output: mine.outputTokens }, anthropic: theirs, scopedToKey: !!opts.apiKeyId },
    });
  }
  return { passed: assertions.length > 0 && assertions.every((a) => a.passed), assertions, provider };
}
