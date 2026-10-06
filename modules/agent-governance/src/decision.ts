import { SENSITIVITY, type ActionType, type AgentStatus, type Effect, type Environment, type Sensitivity, type TimeWindow } from "./schema";

/**
 * Agent action decision — pure and deterministic (the shared policy engine
 * is injected for binding conditions). Order of checks:
 *   1. agent lifecycle (unknown/pending/suspended/retired/quarantined → DENY;
 *      restricted → READ only)
 *   2. kill-switch blocks (blocked connector)
 *   3. least privilege: at least one active, unexpired binding must match
 *      action type, system/connector, resource, environment, data
 *      sensitivity, time window and conditions — otherwise DENY
 *   4. thresholds: amount over every matching binding's financial limit, or a
 *      binding flagged for approval → REQUIRE_APPROVAL
 * Organization policies of kind "agent_action" are evaluated afterwards by the
 * shared policy service and can only make the result stricter.
 */

export interface AgentForDecision {
  id: string;
  name: string;
  status: AgentStatus;
  quarantined: boolean;
  environment: Environment;
  blockedConnectorIds: string[];
}

export interface BindingForDecision {
  id: string;
  actionType: ActionType;
  system: string;
  connectorId: string | null;
  resource: string;
  environment: "any" | Environment;
  maxDataSensitivity: Sensitivity;
  financialLimit: number | null;
  timeWindow: TimeWindow | null;
  conditions: unknown;
  requiresApproval: boolean;
  status: "active" | "disabled";
  expiresAt: Date | null;
}

export interface ActionRequestInput {
  actionType: ActionType;
  /** Business action name, e.g. "refund". Matched by policies, not bindings. */
  action: string;
  /** System type or name (e.g. "salesforce"); matched against binding.system. */
  system: string;
  connectorId?: string | null;
  resource: string;
  environment: Environment;
  dataSensitivity: Sensitivity;
  amount?: number | null;
  context?: Record<string, unknown>;
}

export interface Decision {
  effect: Effect;
  reasons: string[];
  matchedBindingIds: string[];
  bindingId: string | null;
}

export const SENSITIVITY_RANK: Record<Sensitivity, number> = Object.fromEntries(SENSITIVITY.map((s, i) => [s, i])) as Record<Sensitivity, number>;
const READ_ONLY: ActionType[] = ["READ"];

/** Glob match: "*" matches all; "Account/*" matches prefixes; otherwise case-insensitive equality. */
export function matchPattern(pattern: string, value: string): boolean {
  const p = pattern.trim().toLowerCase();
  const v = value.trim().toLowerCase();
  if (p === "*" || p === v) return true;
  if (p.endsWith("*")) return v.startsWith(p.slice(0, -1));
  return false;
}

/** Is `now` inside the window (weekday + hour range, in the window's time zone)? */
export function inTimeWindow(w: TimeWindow, now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: w.timeZone ?? "UTC", weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(now);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const day = ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as Record<string, number>)[wd] ?? 1;
  if (!w.days.includes(day)) return false;
  return w.startHour <= w.endHour ? hour >= w.startHour && hour < w.endHour : hour >= w.startHour || hour < w.endHour;
}

export function decide(
  agent: AgentForDecision,
  bindings: BindingForDecision[],
  req: ActionRequestInput,
  opts: { now?: Date; conditionMatches?: (condition: unknown, req: ActionRequestInput) => boolean } = {},
): Decision {
  const now = opts.now ?? new Date();
  const deny = (reason: string, matched: string[] = []): Decision => ({ effect: "DENY", reasons: [reason], matchedBindingIds: matched, bindingId: null });

  if (agent.quarantined) return deny(`Agent "${agent.name}" is quarantined.`);
  if (agent.status === "suspended") return deny(`Agent "${agent.name}" is suspended.`);
  if (agent.status === "retired") return deny(`Agent "${agent.name}" is retired.`);
  if (agent.status === "unknown" || agent.status === "pending") return deny(`Agent "${agent.name}" is not approved (status ${agent.status}).`);
  if (agent.status === "restricted" && !READ_ONLY.includes(req.actionType)) return deny(`Agent "${agent.name}" is restricted to read-only actions.`);
  if (req.connectorId && agent.blockedConnectorIds.includes(req.connectorId)) return deny("Connector access is blocked for this agent (kill switch).");

  const reasons: string[] = [];
  const candidates = bindings.filter((b) => {
    if (b.status !== "active" || (b.expiresAt && b.expiresAt <= now)) return false;
    if (!actionCovers(b.actionType, req.actionType)) return false;
    if (b.connectorId ? b.connectorId !== req.connectorId : !matchPattern(b.system, req.system)) return false;
    if (!matchPattern(b.resource, req.resource)) return false;
    if (b.environment !== "any" && b.environment !== req.environment) return false;
    return true;
  });
  if (candidates.length === 0) return deny(`Least privilege: no permission binding grants ${req.actionType} on ${req.system}/${req.resource} in ${req.environment}.`);

  const scoped = candidates.filter((b) => {
    if (SENSITIVITY_RANK[req.dataSensitivity] > SENSITIVITY_RANK[b.maxDataSensitivity]) {
      reasons.push(`binding ${b.id.slice(0, 8)}: data sensitivity ${req.dataSensitivity} exceeds ${b.maxDataSensitivity}`);
      return false;
    }
    if (b.timeWindow && !inTimeWindow(b.timeWindow, now)) {
      reasons.push(`binding ${b.id.slice(0, 8)}: outside its allowed time window`);
      return false;
    }
    if (b.conditions && opts.conditionMatches && !opts.conditionMatches(b.conditions, req)) {
      reasons.push(`binding ${b.id.slice(0, 8)}: context conditions not met`);
      return false;
    }
    return true;
  });
  if (scoped.length === 0) return { effect: "DENY", reasons: [`No binding allows this request in scope.`, ...reasons], matchedBindingIds: candidates.map((b) => b.id), bindingId: null };

  // Prefer a binding that allows without approval and covers the amount.
  const amount = req.amount ?? null;
  const covers = (b: BindingForDecision) => amount === null || b.financialLimit === null || amount <= b.financialLimit;
  const clean = scoped.find((b) => covers(b) && !b.requiresApproval);
  if (clean) return { effect: "ALLOW", reasons: [`Allowed by binding ${clean.id.slice(0, 8)} (${clean.actionType} on ${clean.system}/${clean.resource}).`], matchedBindingIds: scoped.map((b) => b.id), bindingId: clean.id };

  const chosen = scoped.find(covers) ?? scoped[0]!;
  const why: string[] = [];
  if (!covers(chosen)) why.push(`amount ${amount} exceeds the binding's financial limit of ${chosen.financialLimit}`);
  if (chosen.requiresApproval) why.push("the binding requires human approval");
  return { effect: "REQUIRE_APPROVAL", reasons: [`Approval required: ${why.join("; ")}.`], matchedBindingIds: scoped.map((b) => b.id), bindingId: chosen.id };
}

/** A WRITE binding also covers CREATE and UPDATE; every other type must match exactly. */
export function actionCovers(granted: ActionType, requested: ActionType): boolean {
  return granted === requested || (granted === "WRITE" && (requested === "CREATE" || requested === "UPDATE"));
}

/** Combine two effects: the most restrictive wins. */
const ORDER: Record<Effect, number> = { ALLOW: 0, REQUIRE_APPROVAL: 1, ESCALATE: 2, DENY: 3 };
export function strictest(a: Effect, b: Effect): Effect {
  return ORDER[b] > ORDER[a] ? b : a;
}

/** Map an Integration connector operation to an agent action type. */
export function actionTypeForOperation(operation: string): ActionType {
  switch (operation) {
    case "read":
    case "list":
    case "search":
      return "READ";
    case "delete":
      return "DELETE";
    case "execute":
      return "EXECUTE";
    default:
      return "WRITE";
  }
}
