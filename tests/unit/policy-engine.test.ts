import { describe, expect, it } from "vitest";
import { PolicyEngine, getPath } from "../../packages/policies/src";

const engine = new PolicyEngine();
const refundPolicy = engine.validate({
  combining: "deny-overrides",
  defaultEffect: "ALLOW",
  rules: [
    { id: "big-refund", description: "Refunds over 500 need approval", effect: "REQUIRE_APPROVAL", actions: ["refund"], when: { field: "resource.attributes.amount", op: "gt", value: 500 } },
    { id: "huge-refund", effect: "ESCALATE", actions: ["refund"], when: { field: "resource.attributes.amount", op: "gt", value: 10_000 } },
    { id: "blocked-agent", effect: "DENY", when: { field: "subject.id", op: "in", value: ["rogue-agent"] } },
    { id: "prod-delete", effect: "DENY", actions: ["record.*"], when: { all: [{ field: "context.environment", op: "eq", value: "production" }, { not: { field: "subject.roles", op: "contains", value: "dba" } }] } },
  ],
});
const input = (o: { subject?: string; amount?: number; action?: string; env?: string; roles?: string[] }) => ({
  subject: { type: "agent", id: o.subject ?? "RefundAgent", roles: o.roles ?? [] },
  resource: { type: "payment", attributes: { amount: o.amount ?? 10 } },
  action: o.action ?? "refund",
  context: { environment: o.env ?? "production" },
});

describe("policy engine", () => {
  it("returns ALLOW / REQUIRE_APPROVAL / ESCALATE / DENY with explanations", () => {
    expect(engine.evaluate(refundPolicy, input({ amount: 100 }))).toMatchObject({ effect: "ALLOW", defaulted: true });
    const approval = engine.evaluate(refundPolicy, input({ amount: 501 }));
    expect(approval.effect).toBe("REQUIRE_APPROVAL");
    expect(approval.reasons[0]).toMatch(/big-refund.*amount gt 500/);
    expect(engine.evaluate(refundPolicy, input({ amount: 20_000 })).effect).toBe("ESCALATE");
    expect(engine.evaluate(refundPolicy, input({ subject: "rogue-agent", amount: 20_000 })).effect).toBe("DENY");
  });

  it("supports action wildcards and nested all/any/not", () => {
    expect(engine.evaluate(refundPolicy, input({ action: "record.delete" })).effect).toBe("DENY");
    expect(engine.evaluate(refundPolicy, input({ action: "record.delete", roles: ["dba"] })).effect).toBe("ALLOW");
    expect(engine.evaluate(refundPolicy, input({ action: "record.delete", env: "staging" })).effect).toBe("ALLOW");
  });

  it("first-match combining stops at the first rule", () => {
    const fm = engine.validate({ combining: "first-match", defaultEffect: "DENY", rules: [{ id: "a", effect: "ALLOW" }, { id: "b", effect: "DENY" }] });
    expect(engine.evaluate(fm, input({})).effect).toBe("ALLOW");
  });

  it("defaults to DENY when nothing matches and no default given", () => {
    const d = engine.validate({ rules: [] });
    expect(engine.evaluate(d, input({})).effect).toBe("DENY");
  });

  it("rejects invalid definitions: unknown operators, bad fields, long regex, duplicate ids", () => {
    expect(() => engine.validate({ rules: [{ id: "x", effect: "ALLOW", when: { field: "resource.a", op: "nope" } }] })).toThrow(/Unknown operator/);
    expect(() => engine.validate({ rules: [{ id: "x", effect: "ALLOW", when: { field: "process.env", op: "eq" } }] })).toThrow();
    expect(() => engine.validate({ rules: [{ id: "x", effect: "ALLOW", when: { field: "resource.a", op: "matches", value: "a".repeat(300) } }] })).toThrow();
    expect(() => engine.validate({ rules: [{ id: "x", effect: "ALLOW" }, { id: "x", effect: "DENY" }] })).toThrow(/Duplicate/);
  });

  it("module operators extend the engine; names must be namespaced", () => {
    const e = new PolicyEngine();
    e.registerOperator("dlp.contains_ssn", (a) => typeof a === "string" && /\d{3}-\d{2}-\d{4}/.test(a));
    expect(() => e.registerOperator("bare", () => true)).toThrow();
    const def = e.validate({ defaultEffect: "ALLOW", rules: [{ id: "ssn", effect: "DENY", when: { field: "context.text", op: "dlp.contains_ssn" } }] });
    expect(e.evaluate(def, { subject: { type: "u", id: "1" }, resource: { type: "t" }, action: "ai.generate", context: { text: "ssn 123-45-6789" } }).effect).toBe("DENY");
  });

  it("path resolution is prototype-safe", () => {
    expect(getPath({ a: { b: 1 } }, "a.b")).toBe(1);
    expect(getPath({}, "__proto__.polluted")).toBeUndefined();
    expect(getPath({ a: 1 }, "a.constructor")).toBeUndefined();
  });
});
