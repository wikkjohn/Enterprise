import { type AIProvider } from "../types";

/**
 * SIMULATED provider for development and automated tests. It does not call
 * any model; output is deterministic and prefixed "[SIMULATED]". Excluded
 * from routing in production.
 */
export const sandboxProvider: AIProvider = {
  kind: "sandbox",
  async generate(req) {
    const last = req.messages[req.messages.length - 1]?.content ?? "";
    if (last.includes("__simulate_refusal__")) {
      return { text: "", servedModel: req.model, finishReason: "refusal", usage: { inputTokens: 5, outputTokens: 0 }, refusalCategory: "simulated" };
    }
    if (last.includes("__simulate_failure__")) throw new Error("Simulated provider failure");
    const text = req.responseFormat === "json" ? JSON.stringify({ simulated: true, echo: last.slice(0, 200) }) : `[SIMULATED] ${last.slice(0, 200)}`;
    const inputTokens = Math.ceil(((req.system ?? "").length + req.messages.reduce((n, m) => n + m.content.length, 0)) / 4);
    return { text, servedModel: req.model, finishReason: "stop", usage: { inputTokens, outputTokens: Math.ceil(text.length / 4) } };
  },
};
