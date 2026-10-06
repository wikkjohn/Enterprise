import { describe, expect, it } from "vitest";
import { actionCovers, actionTypeForOperation, decide, inTimeWindow, matchPattern, strictest, type AgentForDecision, type BindingForDecision, type ActionRequestInput } from "../../modules/agent-governance/src/decision";
import { REVIEW_INTERVAL_DAYS, scoreAgent, type RiskInput } from "../../modules/agent-governance/src/risk";

const agent = (o: Partial<AgentForDecision> = {}): AgentForDecision => ({ id: "a1", name: "RefundAgent", status: "approved", quarantined: false, environment: "production", blockedConnectorIds: [], ...o });
let n = 0;
const binding = (o: Partial<BindingForDecision> = {}): BindingForDecision => ({
  id: `b${++n}-0000-0000`, actionType: "READ", system: "stripe", connectorId: null, resource: "*", environment: "any", maxDataSensitivity: "internal",
  financialLimit: null, timeWindow: null, conditions: null, requiresApproval: false, status: "active", expiresAt: null, ...o,
});
const req = (o: Partial<ActionRequestInput> = {}): ActionRequestInput => ({ actionType: "READ", action: "lookup", system: "stripe", resource: "Charge/ch_1", environment: "production", dataSensitivity: "internal", ...o });

describe("agent decision — lifecycle", () => {
  it("denies every non-operating status and quarantine", () => {
    for (const status of ["unknown", "pending", "suspended", "retired"] as const) expect(decide(agent({ status }), [binding()], req()).effect).toBe("DENY");
    expect(decide(agent({ quarantined: true }), [binding()], req()).effect).toBe("DENY");
  });
  it("restricted agents may only READ", () => {
    expect(decide(agent({ status: "restricted" }), [binding()], req()).effect).toBe("ALLOW");
    expect(decide(agent({ status: "restricted" }), [binding({ actionType: "WRITE" })], req({ actionType: "WRITE" })).reasons[0]).toMatch(/read-only/);
  });
  it("blocked connectors are denied before bindings are considered", () => {
    expect(decide(agent({ blockedConnectorIds: ["c1"] }), [binding({ connectorId: "c1" })], req({ connectorId: "c1" })).effect).toBe("DENY");
  });
});

describe("agent decision — least privilege", () => {
  it("denies with no matching binding", () => {
    const d = decide(agent(), [], req());
    expect(d.effect).toBe("DENY");
    expect(d.reasons[0]).toMatch(/Least privilege/);
  });
  it("matches action type, system, resource and environment exactly", () => {
    expect(decide(agent(), [binding()], req({ actionType: "DELETE" })).effect).toBe("DENY");
    expect(decide(agent(), [binding()], req({ system: "salesforce" })).effect).toBe("DENY");
    expect(decide(agent(), [binding({ resource: "Customer/*" })], req()).effect).toBe("DENY");
    expect(decide(agent(), [binding({ resource: "Charge/*" })], req()).effect).toBe("ALLOW");
    expect(decide(agent(), [binding({ environment: "staging" })], req()).effect).toBe("DENY");
  });
  it("WRITE covers CREATE/UPDATE only", () => {
    expect(actionCovers("WRITE", "CREATE")).toBe(true);
    expect(actionCovers("WRITE", "UPDATE")).toBe(true);
    expect(actionCovers("WRITE", "DELETE")).toBe(false);
    expect(actionCovers("READ", "EXPORT")).toBe(false);
  });
  it("a connector-scoped binding never matches a different connector", () => {
    expect(decide(agent(), [binding({ connectorId: "c1" })], req({ connectorId: "c2" })).effect).toBe("DENY");
    expect(decide(agent(), [binding({ connectorId: "c1" })], req({ connectorId: "c1", system: "anything" })).effect).toBe("ALLOW");
  });
  it("disabled and expired bindings grant nothing", () => {
    expect(decide(agent(), [binding({ status: "disabled" })], req()).effect).toBe("DENY");
    expect(decide(agent(), [binding({ expiresAt: new Date(Date.now() - 1000) })], req()).effect).toBe("DENY");
  });
  it("data sensitivity above the binding's ceiling is denied", () => {
    const d = decide(agent(), [binding({ maxDataSensitivity: "internal" })], req({ dataSensitivity: "restricted" }));
    expect(d.effect).toBe("DENY");
    expect(d.reasons.join(" ")).toMatch(/sensitivity/);
  });
  it("time windows are evaluated in the window's time zone", () => {
    const mondayNoonUtc = new Date("2026-10-05T12:00:00Z");
    expect(inTimeWindow({ days: [1, 2, 3, 4, 5], startHour: 9, endHour: 17 }, mondayNoonUtc)).toBe(true);
    expect(inTimeWindow({ days: [1, 2, 3, 4, 5], startHour: 9, endHour: 17, timeZone: "America/Los_Angeles" }, mondayNoonUtc)).toBe(false); // 05:00 PT
    expect(inTimeWindow({ days: [6, 7], startHour: 0, endHour: 24 }, mondayNoonUtc)).toBe(false);
    expect(inTimeWindow({ days: [1], startHour: 22, endHour: 6 }, new Date("2026-10-05T23:30:00Z"))).toBe(true); // overnight window
    const d = decide(agent(), [binding({ timeWindow: { days: [6, 7], startHour: 0, endHour: 24 } })], req(), { now: mondayNoonUtc });
    expect(d.effect).toBe("DENY");
  });
  it("conditions are checked through the injected matcher", () => {
    const b = binding({ conditions: { field: "context.region", op: "eq", value: "EU" } });
    expect(decide(agent(), [b], req(), { conditionMatches: () => false }).effect).toBe("DENY");
    expect(decide(agent(), [b], req(), { conditionMatches: () => true }).effect).toBe("ALLOW");
  });
});

describe("agent decision — thresholds", () => {
  const refund = (amount: number, extra: Partial<BindingForDecision> = {}) => decide(agent(), [binding({ actionType: "EXECUTE", financialLimit: 500, ...extra })], req({ actionType: "EXECUTE", action: "refund", amount }));
  it("amounts within the financial limit are allowed; above it require approval", () => {
    expect(refund(499).effect).toBe("ALLOW");
    const d = refund(900);
    expect(d.effect).toBe("REQUIRE_APPROVAL");
    expect(d.reasons[0]).toMatch(/exceeds .* 500/);
  });
  it("a binding flagged for approval always requires approval", () => {
    expect(refund(10, { requiresApproval: true }).effect).toBe("REQUIRE_APPROVAL");
  });
  it("prefers a clean binding when several match", () => {
    const d = decide(agent(), [binding({ actionType: "EXECUTE", requiresApproval: true }), binding({ actionType: "EXECUTE", financialLimit: 1000 })], req({ actionType: "EXECUTE", amount: 600 }));
    expect(d.effect).toBe("ALLOW");
    expect(d.matchedBindingIds).toHaveLength(2);
  });
  it("strictest() never loosens", () => {
    expect(strictest("ALLOW", "REQUIRE_APPROVAL")).toBe("REQUIRE_APPROVAL");
    expect(strictest("DENY", "ALLOW")).toBe("DENY");
    expect(strictest("REQUIRE_APPROVAL", "ESCALATE")).toBe("ESCALATE");
  });
  it("maps connector operations to action types", () => {
    expect(actionTypeForOperation("list")).toBe("READ");
    expect(actionTypeForOperation("write")).toBe("WRITE");
    expect(actionTypeForOperation("delete")).toBe("DELETE");
    expect(actionTypeForOperation("execute")).toBe("EXECUTE");
  });
  it("matchPattern supports * and prefix globs, case-insensitively", () => {
    expect(matchPattern("*", "x")).toBe(true);
    expect(matchPattern("Account/*", "account/42")).toBe(true);
    expect(matchPattern("Account", "Accounts")).toBe(false);
  });
});

describe("agent risk score", () => {
  const base: RiskInput = { environment: "development", autonomyLevel: "assistive", connectedSystems: [], customerImpact: 1, regulatoryImpact: 1, bindings: [], recentViolations: 0 };
  it("a minimal agent scores 0 / low", () => {
    const r = scoreAgent(base);
    expect(r.score).toBe(0);
    expect(r.band).toBe("low");
    expect(r.components).toHaveLength(9);
  });
  it("a powerful autonomous production agent is critical, and explains why", () => {
    const r = scoreAgent({
      environment: "production", autonomyLevel: "autonomous", connectedSystems: ["stripe", "salesforce", "slack", "sap", "jira", "m365"], customerImpact: 5, regulatoryImpact: 5,
      bindings: [{ actionType: "SEND", system: "*", maxDataSensitivity: "restricted", financialLimit: 250_000, environment: "any", status: "active" }], recentViolations: 12,
    });
    expect(r.score).toBe(100);
    expect(r.band).toBe("critical");
    expect(r.explanation).toMatch(/Largest contributors/);
    expect(REVIEW_INTERVAL_DAYS[r.band]).toBe(30);
  });
  it("unrated impacts are assumed neutral and flagged as assumed", () => {
    const r = scoreAgent({ ...base, customerImpact: null, regulatoryImpact: null });
    expect(r.components.filter((c) => c.assumed).map((c) => c.factor)).toEqual(["customer_impact", "regulatory_impact"]);
    expect(r.score).toBe(10);
    expect(r.explanation).toMatch(/Assumed/);
  });
  it("disabled bindings do not count", () => {
    const r = scoreAgent({ ...base, bindings: [{ actionType: "SEND", system: "*", maxDataSensitivity: "restricted", financialLimit: 1e6, environment: "any", status: "disabled" }] });
    expect(r.score).toBe(0);
  });
});
