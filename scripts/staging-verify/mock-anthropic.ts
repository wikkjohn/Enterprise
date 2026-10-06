import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";

/**
 * A local stand-in for the Claude API, used when no ANTHROPIC_API_KEY is
 * available (and by the integration test). It speaks the Messages API wire
 * format so the real adapter, SDK and wire capture run unchanged, and it
 * answers grounded questions the way the platform's answer prompt asks:
 * quoting the best-matching source sentence with its [S#] marker. It also
 * serves a minimal Usage Admin API report built from the requests it saw,
 * so the reconciliation path can be exercised offline.
 */
export interface MockAnthropic {
  url: string;
  requests: Array<{ path: string; body: unknown }>;
  close(): Promise<void>;
}

const STOP = new Set("what which when where with that this from does have your there their about into for and the are how many much per is of to a an in on do any get".split(" "));
const words = (s: string) => (s.toLowerCase().match(/[a-z0-9$][a-z0-9$,.]*[a-z0-9]|[a-z0-9]/g) ?? []).map((w) => w.replace(/[.,]$/, "")).filter((w) => w.length > 2 && !STOP.has(w));
const tokens = (s: string) => Math.max(1, Math.ceil(s.length / 4));

/** Answer from the "Sources: … Question: …" prompt the Knowledge module sends. */
function groundedAnswer(prompt: string): string | null {
  const q = prompt.match(/\n\nQuestion: ([\s\S]*)$/);
  if (!prompt.startsWith("Sources:") || !q) return null;
  const qWords = new Set(words(q[1]!));
  const blocks = prompt.slice("Sources:".length, q.index).split(/\n\n(?=\[S\d+\] )/);
  let best: { score: number; sentence: string; marker: string } | null = null;
  for (const b of blocks) {
    const marker = b.match(/\[(S\d+)\]/)?.[1];
    if (!marker) continue;
    const body = b.split("\n").slice(1).filter((l) => !l.startsWith("Section: ")).join(" ");
    for (const sentence of body.split(/(?<=[.!?])\s+/)) {
      const score = words(sentence).filter((w) => qWords.has(w)).length;
      if (score > (best?.score ?? 1)) best = { score, sentence: sentence.trim(), marker };
    }
  }
  return best ? `${best.sentence.replace(/[.!?]$/, "")} [${best.marker}].` : "The provided sources do not answer this question.";
}

/**
 * Faults the stand-in can inject, so tests can prove each check catches what it is meant to catch:
 * - ungrounded:   knowledge answers state an invented figure with a citation
 * - cache_tokens: responses report prompt-cache reads the metering does not price
 * - fallback:     Opus requests are served by Sonnet (as a server-side fallback would)
 */
export type MockFault = "ungrounded" | "cache_tokens" | "fallback";

export async function startMockAnthropic(faults: MockFault[] = []): Promise<MockAnthropic> {
  const requests: MockAnthropic["requests"] = [];
  const served: Array<{ at: number; model: string; input: number; output: number }> = [];
  let n = 0;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0]!;
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      };
      if (req.method === "POST" && path === "/v1/messages") {
        const body = JSON.parse(raw || "{}") as { model: string; system?: string; messages: Array<{ content: string }> };
        requests.push({ path, body });
        if (req.headers["x-api-key"] !== MOCK_API_KEY) return send(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
        const user = body.messages.map((m) => m.content).join("\n");
        const grounded = groundedAnswer(user);
        const text = grounded !== null && faults.includes("ungrounded") ? "Vantrel employees also receive a $95 wellness stipend every month [S1]." : (grounded ?? `Acknowledged (${user.length} characters received).`);
        const usage = { input_tokens: tokens(`${body.system ?? ""}${user}`), output_tokens: tokens(text), cache_creation_input_tokens: 0, cache_read_input_tokens: faults.includes("cache_tokens") ? 120 : 0 };
        const model = faults.includes("fallback") && body.model === "claude-opus-5-5" ? "claude-sonnet-5-5" : body.model;
        served.push({ at: Date.now(), model, input: usage.input_tokens, output: usage.output_tokens });
        n += 1;
        return send(200, { id: `msg_mock_${n}`, type: "message", role: "assistant", model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage }, { "request-id": `req_mock_${n}` });
      }
      if (req.method === "GET" && path === "/v1/organizations/usage_report/messages") {
        requests.push({ path, body: null });
        if (req.headers["x-api-key"] !== MOCK_ADMIN_KEY) return send(401, { type: "error", error: { type: "authentication_error", message: "invalid admin key" } });
        const byModel = new Map<string, { input: number; output: number }>();
        for (const s of served) {
          const cur = byModel.get(s.model) ?? { input: 0, output: 0 };
          cur.input += s.input;
          cur.output += s.output;
          byModel.set(s.model, cur);
        }
        const results = [...byModel].map(([model, t]) => ({ model, uncached_input_tokens: t.input, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, output_tokens: t.output }));
        return send(200, { data: [{ starting_at: new Date(Date.now() - 3_600_000).toISOString(), ending_at: new Date().toISOString(), results }], has_more: false, next_page: null });
      }
      send(404, { type: "error", error: { type: "not_found_error", message: path } });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(() => r())) };
}

export const MOCK_API_KEY = "sk-ant-mock-staging-verification";
export const MOCK_ADMIN_KEY = "sk-ant-admin-mock-staging-verification";
