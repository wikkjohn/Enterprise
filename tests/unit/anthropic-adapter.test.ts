import { createServer, type IncomingHttpHeaders } from "node:http";
import { type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anthropicProvider } from "../../packages/ai/src";

let captured: { headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
let reply: (body: Record<string, unknown>) => { status: number; json: unknown } = (b) => ({
  status: 200,
  json: { id: "msg_1", type: "message", role: "assistant", model: b.model, content: [{ type: "text", text: "hello" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 11, output_tokens: 3 } },
});
const server = createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    const body = JSON.parse(data) as Record<string, unknown>;
    captured.push({ headers: req.headers, body });
    const r = reply(body);
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(JSON.stringify(r.json));
  });
});
let baseUrl = "";
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const runtime = () => ({ apiKey: "test-key", config: { baseUrl } });
const signal = () => AbortSignal.timeout(5000);

describe("Anthropic adapter (official SDK) wire format", () => {
  it("sends explicit effort, no sampling params, and opts into refusal fallback", async () => {
    captured = [];
    const r = await anthropicProvider.generate({ model: "claude-opus-5-5", system: "sys", messages: [{ role: "user", content: "hi" }], maxTokens: 1000, temperature: 0.2 }, runtime(), signal());
    const sent = captured[0]!;
    expect(sent.body).toMatchObject({ model: "claude-opus-5-5", max_tokens: 1000, system: "sys", output_config: { effort: "medium" }, fallbacks: "default" });
    expect(sent.body).not.toHaveProperty("temperature");
    expect(sent.body).not.toHaveProperty("thinking");
    expect(String(sent.headers["anthropic-beta"])).toContain("server-side-fallback-2026-07-01");
    expect(sent.headers["x-api-key"]).toBe("test-key");
    expect(r).toMatchObject({ text: "hello", servedModel: "claude-opus-5-5", finishReason: "stop", usage: { inputTokens: 11, outputTokens: 3 } });
  });

  it("omits effort and fallbacks where unsupported (Haiku 4.5) and can disable fallback", async () => {
    captured = [];
    await anthropicProvider.generate({ model: "claude-haiku-4-5", messages: [{ role: "user", content: "hi" }], maxTokens: 10 }, runtime(), signal());
    expect(captured[0]!.body).not.toHaveProperty("output_config");
    expect(captured[0]!.body).not.toHaveProperty("fallbacks");
    captured = [];
    await anthropicProvider.generate({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: "hi" }], maxTokens: 10, effort: "low" }, { apiKey: "k", config: { baseUrl, refusalFallback: "off" } }, signal());
    expect(captured[0]!.body).toMatchObject({ output_config: { effort: "low" } });
    expect(captured[0]!.body).not.toHaveProperty("fallbacks");
  });

  it("maps stop_reason refusal and reports the model that served a fallback", async () => {
    reply = () => ({ status: 200, json: { id: "m", type: "message", role: "assistant", model: "claude-opus-5", content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber" }, usage: { input_tokens: 5, output_tokens: 0 } } });
    const r = await anthropicProvider.generate({ model: "claude-opus-5-5", messages: [{ role: "user", content: "x" }], maxTokens: 10 }, runtime(), signal());
    expect(r).toMatchObject({ finishReason: "refusal", refusalCategory: "cyber", servedModel: "claude-opus-5", text: "" });
  });

  it("maps typed SDK errors to platform error codes", async () => {
    reply = () => ({ status: 401, json: { type: "error", error: { type: "authentication_error", message: "bad key" } } });
    await expect(anthropicProvider.generate({ model: "claude-opus-5-5", messages: [{ role: "user", content: "x" }], maxTokens: 10 }, runtime(), signal())).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    reply = () => ({ status: 400, json: { type: "error", error: { type: "invalid_request_error", message: "nope" } } });
    await expect(anthropicProvider.generate({ model: "claude-opus-5-5", messages: [{ role: "user", content: "x" }], maxTokens: 10 }, runtime(), signal())).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("fails closed without credentials", async () => {
    await expect(anthropicProvider.generate({ model: "claude-opus-5-5", messages: [{ role: "user", content: "x" }], maxTokens: 10 }, { config: {} }, signal())).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });
});
