import { z } from "zod";
import { POLICY_EFFECT_PRECEDENCE, POLICY_EFFECTS, type PolicyEffect } from "@eaop/shared-types";

/**
 * Shared policy engine primitives.
 *
 * A policy evaluates  { subject, resource, action, context }  and returns
 * ALLOW | DENY | REQUIRE_APPROVAL | ESCALATE with the rules that matched and a
 * human-readable trace. The engine is deterministic, side-effect free and has
 * no I/O, so it is safe to call on hot paths and trivially testable.
 *
 * Modules extend it by:
 *   - registering policy KINDS (e.g. "agent_action", "ai_dlp") with an input
 *     schema describing the attributes they supply, and
 *   - registering custom OPERATORS (e.g. "matches_classifier").
 * Modules must not fork the engine.
 */
export interface PolicyInput {
  subject: { type: string; id: string; roles?: string[]; attributes?: Record<string, unknown> };
  resource: { type: string; id?: string; attributes?: Record<string, unknown> };
  action: string;
  context?: Record<string, unknown>;
}

export const BUILTIN_OPERATORS = ["eq", "neq", "gt", "gte", "lt", "lte", "in", "nin", "contains", "exists", "starts_with", "matches"] as const;

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { field: string; op: string; value?: unknown };

const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(conditionSchema).min(1).max(50) }).strict(),
    z.object({ any: z.array(conditionSchema).min(1).max(50) }).strict(),
    z.object({ not: conditionSchema }).strict(),
    z
      .object({
        field: z.string().regex(/^(subject|resource|action|context)(\.[A-Za-z0-9_]+)*$/, "field must start with subject, resource, action or context"),
        op: z.string().min(1).max(64),
        value: z.unknown().optional(),
      })
      .strict(),
  ]),
);

export const policyRuleSchema = z.object({
  id: z.string().min(1).max(64),
  description: z.string().max(500).default(""),
  effect: z.enum(POLICY_EFFECTS),
  /** Optional action filter; "*" or omitted matches any action. Supports "prefix.*". */
  actions: z.array(z.string().max(120)).max(50).optional(),
  when: conditionSchema.optional(),
});

export const policyDefinitionSchema = z.object({
  /** deny-overrides: most restrictive matching effect wins. first-match: rules in order. */
  combining: z.enum(["deny-overrides", "first-match"]).default("deny-overrides"),
  defaultEffect: z.enum(POLICY_EFFECTS).default("DENY"),
  rules: z.array(policyRuleSchema).max(200),
});
export type PolicyDefinition = z.infer<typeof policyDefinitionSchema>;
export type PolicyRule = z.infer<typeof policyRuleSchema>;

export interface PolicyDecision {
  effect: PolicyEffect;
  matchedRules: Array<{ id: string; effect: PolicyEffect; description: string }>;
  /** True when no rule matched and the default applied. */
  defaulted: boolean;
  reasons: string[];
}

export type OperatorFn = (actual: unknown, expected: unknown) => boolean;

function cmp(a: unknown, b: unknown): number | undefined {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") {
    const da = Date.parse(a);
    const db = Date.parse(b);
    if (!Number.isNaN(da) && !Number.isNaN(db) && /\d{4}-\d{2}-\d{2}/.test(a)) return da - db;
    return a.localeCompare(b);
  }
  return undefined;
}

const MAX_REGEX = 200;
const regexCache = new Map<string, RegExp>();

const builtins: Record<string, OperatorFn> = {
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
  gt: (a, b) => (cmp(a, b) ?? NaN) > 0,
  gte: (a, b) => (cmp(a, b) ?? NaN) >= 0,
  lt: (a, b) => (cmp(a, b) ?? NaN) < 0,
  lte: (a, b) => (cmp(a, b) ?? NaN) <= 0,
  in: (a, b) => Array.isArray(b) && b.includes(a),
  nin: (a, b) => Array.isArray(b) && !b.includes(a),
  contains: (a, b) => (Array.isArray(a) ? a.includes(b) : typeof a === "string" && typeof b === "string" && a.includes(b)),
  exists: (a, b) => (b === false ? a === undefined || a === null : a !== undefined && a !== null),
  starts_with: (a, b) => typeof a === "string" && typeof b === "string" && a.startsWith(b),
  matches: (a, b) => {
    if (typeof a !== "string" || typeof b !== "string" || b.length > MAX_REGEX) return false;
    let re = regexCache.get(b);
    if (!re) {
      re = new RegExp(b);
      if (regexCache.size > 500) regexCache.clear();
      regexCache.set(b, re);
    }
    return re.test(a.slice(0, 10_000));
  },
};

export class PolicyEngine {
  private operators = new Map<string, OperatorFn>(Object.entries(builtins));

  /** Register a module operator. Names must be namespaced ("dlp.contains_pii"). */
  registerOperator(name: string, fn: OperatorFn) {
    if (this.operators.has(name)) throw new Error(`Operator "${name}" already registered`);
    if (!name.includes(".")) throw new Error("Custom operators must be namespaced, e.g. 'module.op'");
    this.operators.set(name, fn);
  }

  hasOperator(name: string) {
    return this.operators.has(name);
  }

  /** Parse + verify operators exist. Throws a ZodError / Error with a useful message. */
  validate(definition: unknown): PolicyDefinition {
    const def = policyDefinitionSchema.parse(definition);
    const walk = (c: Condition) => {
      if ("all" in c) c.all.forEach(walk);
      else if ("any" in c) c.any.forEach(walk);
      else if ("not" in c) walk(c.not);
      else {
        if (!this.operators.has(c.op)) throw new Error(`Unknown operator "${c.op}"`);
        if (c.op === "matches") {
          if (typeof c.value !== "string" || c.value.length > MAX_REGEX) throw new Error("matches requires a regex string ≤ 200 chars");
          new RegExp(c.value); // syntax check
        }
      }
    };
    def.rules.forEach((r) => r.when && walk(r.when));
    const ids = new Set<string>();
    for (const r of def.rules) {
      if (ids.has(r.id)) throw new Error(`Duplicate rule id "${r.id}"`);
      ids.add(r.id);
    }
    return def;
  }

  evaluate(def: PolicyDefinition, input: PolicyInput): PolicyDecision {
    const doc = { subject: input.subject, resource: input.resource, action: input.action, context: input.context ?? {} };
    const matched: PolicyDecision["matchedRules"] = [];
    const reasons: string[] = [];

    for (const rule of def.rules) {
      if (!actionMatches(rule.actions, input.action)) continue;
      const trace: string[] = [];
      if (rule.when && !this.test(rule.when, doc, trace)) continue;
      matched.push({ id: rule.id, effect: rule.effect, description: rule.description });
      reasons.push(`rule "${rule.id}" → ${rule.effect}${rule.description ? `: ${rule.description}` : ""}${trace.length ? ` (${trace.join("; ")})` : ""}`);
      if (def.combining === "first-match") break;
    }

    if (matched.length === 0) {
      return { effect: def.defaultEffect, matchedRules: [], defaulted: true, reasons: [`no rule matched → default ${def.defaultEffect}`] };
    }
    const effect = matched.reduce<PolicyEffect>(
      (acc, m) => (def.combining === "first-match" ? matched[0]!.effect : POLICY_EFFECT_PRECEDENCE[m.effect] > POLICY_EFFECT_PRECEDENCE[acc] ? m.effect : acc),
      matched[0]!.effect,
    );
    return { effect, matchedRules: matched, defaulted: false, reasons };
  }

  private test(c: Condition, doc: Record<string, unknown>, trace: string[]): boolean {
    if ("all" in c) return c.all.every((x) => this.test(x, doc, trace));
    if ("any" in c) return c.any.some((x) => this.test(x, doc, trace));
    if ("not" in c) return !this.test(c.not, doc, []);
    const actual = getPath(doc, c.field);
    const fn = this.operators.get(c.op);
    if (!fn) return false; // fail closed: unknown operator never matches an ALLOW
    const ok = fn(actual, c.value);
    if (ok) trace.push(`${c.field} ${c.op} ${JSON.stringify(c.value)}`);
    return ok;
  }
}

function actionMatches(patterns: string[] | undefined, action: string) {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((p) => p === "*" || p === action || (p.endsWith(".*") && action.startsWith(p.slice(0, -1))));
}

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (FORBIDDEN_SEGMENTS.has(seg)) return undefined;
    if (cur === null || typeof cur !== "object") return undefined;
    cur = Object.prototype.hasOwnProperty.call(cur, seg) ? (cur as Record<string, unknown>)[seg] : undefined;
  }
  return cur;
}

/** A policy kind registered by the core or a module (e.g. "agent_action"). */
export interface PolicyKind {
  key: string;
  owner: string;
  description: string;
  /** Documented attributes the owner supplies when evaluating this kind. */
  attributes: Record<string, string>;
  /** Default definition for new policies of this kind. */
  template?: PolicyDefinition;
}
