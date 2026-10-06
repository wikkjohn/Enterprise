import { describe, expect, it } from "vitest";
import { ConnectorError } from "../../packages/connectors/src";
import { callerHeaders } from "../../packages/connectors/src/adapters/rest";
import { AppError } from "../../packages/shared-types/src";
import {
  ACTION_TEMPLATES, applyMappings, breakerState, classifyError, compute, convert, decideRetry, IntegrationError, parseJsonSchema, render, resolvePath, sampleFromSchema,
  summarizePayload, toolDefinition, validate, validateGraph, type EdgeDef, type NodeDef,
} from "../../modules/integration-hub/src";
import { SAMPLE_EDGES, SAMPLE_NODES } from "../../modules/integration-hub/src/samples";

describe("schema validation", () => {
  const schema = parseJsonSchema({
    type: "object",
    required: ["email", "qty"],
    properties: {
      email: { type: "string", format: "email" },
      qty: { type: "integer", minimum: 1, maximum: 10 },
      tier: { type: "string", enum: ["gold", "silver"], default: "silver" },
      tags: { type: "array", items: { type: "string", maxLength: 5 }, maxItems: 2 },
    },
  });
  it("accepts valid input and applies defaults", () => {
    const r = validate(schema, { email: "a@b.co", qty: 3 });
    expect(r.issues).toEqual([]);
    expect(r.value).toEqual({ email: "a@b.co", qty: 3, tier: "silver" });
  });
  it("reports every violation with a path", () => {
    const r = validate(schema, { email: "nope", qty: 2.5, tier: "bronze", tags: ["toolong", "a", "b"], extra: 1 });
    const paths = r.issues.map((i) => `${i.path}: ${i.message}`);
    expect(paths).toEqual(expect.arrayContaining([
      "email: must be a valid email", "qty: must be an integer", "tier: must be one of gold, silver", "tags: must have at most 2 items", "tags[0]: must be at most 5 characters", "extra: is not an allowed field",
    ]));
  });
  it("requires required fields", () => {
    expect(validate(schema, {}).issues.map((i) => i.path).sort()).toEqual(["email", "qty"]);
  });
  it("rejects malformed schemas", () => {
    expect(() => parseJsonSchema({ type: "object", required: ["x"], properties: {} })).toThrow(/required field "x"/);
    expect(() => parseJsonSchema({ type: "string", pattern: "(" })).toThrow();
    expect(() => parseJsonSchema({ type: "object", $ref: "#/x" })).toThrow();
  });
  it("every built-in template has a valid object input schema and builds a tool definition", () => {
    for (const t of ACTION_TEMPLATES) {
      expect(parseJsonSchema(t.inputSchema).type).toBe("object");
      expect(toolDefinition({ ...t, description: t.description }).input_schema).toBe(t.inputSchema);
    }
  });
  it("produces schema-conforming samples for test mode", () => {
    const s = parseJsonSchema({ type: "object", required: ["a", "b"], properties: { a: { type: "string", enum: ["x"] }, b: { type: "integer", minimum: 2 }, c: { type: "boolean" } } });
    expect(validate(s, sampleFromSchema(s)).issues).toEqual([]);
  });
});

describe("data mapping", () => {
  const scope = { input: { customer: { email: " Ann@Example.COM ", tier: "" }, items: [{ sku: "A1", qty: "3" }] }, steps: { price: { unit: 9.5 } } };
  it("resolves dotted and indexed paths, and blocks prototype access", () => {
    expect(resolvePath(scope, "input.items[0].sku")).toBe("A1");
    expect(resolvePath(scope, "input.items.length")).toBe(1);
    expect(resolvePath(scope, "input.__proto__")).toBeUndefined();
    expect(resolvePath(scope, "input.missing.deep")).toBeUndefined();
  });
  it("renders templates: whole placeholders keep type, inline ones interpolate", () => {
    expect(render({ q: "{{input.items[0].qty}}", n: "{{steps.price.unit}}", s: "SKU {{input.items[0].sku}}!", gone: "{{nope}}" }, scope)).toEqual({ q: "3", n: 9.5, s: "SKU A1!" });
  });
  it("maps source → normalized → destination with transforms, types, fallbacks and required checks", () => {
    const r = applyMappings(
      [
        { target: "contact.email", source: "input.customer.email", transforms: ["trim", "lowercase"], type: "string", required: true },
        { target: "qty", source: "input.items[0].qty", type: "integer", required: true, transforms: [] },
        { target: "tier", source: "input.customer.tier", fallback: "standard", transforms: [], required: false },
        { target: "total", compute: { op: "multiply", args: ["input.items[0].qty", "steps.price.unit"] }, type: "number", transforms: [], required: true },
        { target: "flag", value: "yes", type: "boolean", transforms: [], required: false },
      ],
      scope,
    );
    expect(r.issues).toEqual([]);
    expect(r.output).toEqual({ contact: { email: "ann@example.com" }, qty: 3, tier: "standard", total: 28.5, flag: true });
  });
  it("reports missing required values and impossible conversions", () => {
    const r = applyMappings([
      { target: "a", source: "input.nothing", required: true, transforms: [] },
      { target: "b", value: "abc", type: "number", required: false, transforms: [] },
    ], scope);
    expect(r.issues.map((i) => i.target)).toEqual(["a", "b"]);
  });
  it("never produces NaN", () => {
    expect(compute({ op: "divide", args: [1, 0] }, {})).toBeUndefined();
    expect(compute({ op: "add", args: ["x.y", 1] }, {})).toBeUndefined();
    expect(compute({ op: "percent", args: [200, 5] }, {})).toBe(10);
    expect(convert("2026-03-04T10:00:00Z", "date")).toEqual({ ok: true, value: "2026-03-04" });
    expect(convert("maybe", "boolean")).toEqual({ ok: false });
  });
});

describe("reliability", () => {
  it("classifies connector, app and timeout errors without leaking internals", () => {
    expect(classifyError(new ConnectorError("rate_limited", "slow down", 12, 429))).toMatchObject({ errorClass: "rate_limited", retryable: true, retryAfterSeconds: 12 });
    expect(classifyError(new ConnectorError("permanent", "bad request", undefined, 400))).toMatchObject({ errorClass: "permanent", retryable: false });
    expect(classifyError(new AppError("FORBIDDEN"))).toMatchObject({ errorClass: "forbidden", retryable: false });
    expect(classifyError(new IntegrationError("timeout", "Timed out"))).toMatchObject({ errorClass: "timeout", retryable: true });
    const internal = classifyError(new Error("db password=hunter2 at line 7"));
    expect(internal.errorClass).toBe("internal");
    expect(internal.message).not.toMatch(/hunter2/);
  });
  it("retries only retryable errors, with exponential backoff honouring Retry-After", () => {
    const policy = { maxAttempts: 3, backoffSeconds: 10 };
    expect(decideRetry({ errorClass: "transient", retryable: true, message: "" }, 1, policy)).toMatchObject({ retry: true, delaySeconds: 10 });
    expect(decideRetry({ errorClass: "transient", retryable: true, message: "" }, 2, policy)).toMatchObject({ retry: true, delaySeconds: 20 });
    expect(decideRetry({ errorClass: "rate_limited", retryable: true, message: "", retryAfterSeconds: 90 }, 1, policy).delaySeconds).toBe(90);
    expect(decideRetry({ errorClass: "transient", retryable: true, message: "" }, 3, policy).retry).toBe(false);
    expect(decideRetry({ errorClass: "validation", retryable: false, message: "" }, 1, policy).retry).toBe(false);
  });
  it("opens the circuit after repeated failures, half-opens after cooldown", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const ago = (s: number) => new Date(now.getTime() - s * 1000);
    expect(breakerState([ago(1), ago(2)], now).state).toBe("closed");
    expect(breakerState([1, 2, 3, 4, 5].map(ago), now)).toMatchObject({ state: "open", recentFailures: 5 });
    expect(breakerState([100, 110, 120, 130, 140].map(ago), now).state).toBe("half_open");
    expect(breakerState([400, 500, 600, 700, 800].map(ago), now).state).toBe("closed");
  });
  it("redacts secrets in execution history unless payload capture is on", () => {
    expect(summarizePayload({ apiKey: "sk-123", password: "x", nested: { name: "ok" } }, false)).toEqual({ apiKey: "[redacted]", password: "[redacted]", nested: { name: "ok" } });
  });
  it("custom REST headers can never carry credentials", () => {
    expect(callerHeaders({ Authorization: "Bearer x", Cookie: "a", "Idempotency-Key": "k1", "X-Bad": "a\r\nInjected: 1", "X-Source": "eaop" })).toEqual({ "Idempotency-Key": "k1", "X-Source": "eaop" });
  });
});

describe("workflow graph validation", () => {
  it("accepts the sample quote workflow", () => {
    const keys = new Set(["sample.lookup_customer", "sample.check_inventory", "sample.create_quote", "sample.update_crm"]);
    expect(validateGraph(SAMPLE_NODES, SAMPLE_EDGES, keys)).toEqual([]);
  });
  it("flags structural problems", () => {
    const nodes: NodeDef[] = [
      { key: "a", type: "trigger", name: "A", config: {}, position: { x: 0, y: 0 } },
      { key: "b", type: "condition", name: "B", config: { condition: { field: "input.x", op: "eq", value: 1 } }, position: { x: 0, y: 0 } },
      { key: "c", type: "connector_action", name: "C", config: { actionKey: "missing", input: {} }, position: { x: 0, y: 0 } },
      { key: "d", type: "completion", name: "D", config: { output: {} }, position: { x: 0, y: 0 } },
      { key: "orphan", type: "delay", name: "E", config: { seconds: 5 }, position: { x: 0, y: 0 } },
    ];
    const edges: EdgeDef[] = [
      { from: "a", to: "b", kind: "next" },
      { from: "b", to: "c", kind: "true" },
      { from: "c", to: "b", kind: "next" },
      { from: "d", to: "a", kind: "next" },
    ];
    const msgs = validateGraph(nodes, edges, new Set()).map((i) => `${i.node ?? "*"}: ${i.message}`);
    expect(msgs).toEqual(expect.arrayContaining([
      expect.stringMatching(/^b: config condition/),
      'c: action "missing" does not exist or is disabled',
      'b: needs a "false" edge',
      "d: completion nodes cannot have \"next\" edges",
      "a: nothing may connect into the trigger",
      "orphan: not reachable from the trigger",
      "*: the workflow contains a cycle — use retry nodes instead of loops",
    ]));
  });
});
