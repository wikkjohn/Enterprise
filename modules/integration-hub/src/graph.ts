import { z } from "zod";
import { mappingsSchema } from "./mapping";
import { EDGE_KINDS, NODE_TYPES, RISK_LEVELS, type EdgeDef, type EdgeKind, type NodeDef, type NodeType } from "./schema";
import { jsonSchemaSchema } from "./validation";

/**
 * Workflow graph model + validation. Pure. Drafts may be saved with issues;
 * publishing requires a graph with zero issues.
 */

const template = z.union([z.record(z.unknown()), z.string().max(2000)]).default({});
const conditionSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(conditionSchema).min(1).max(20) }).strict(),
    z.object({ any: z.array(conditionSchema).min(1).max(20) }).strict(),
    z.object({ not: conditionSchema }).strict(),
    z.object({ field: z.string().regex(/^context(\.[A-Za-z0-9_]+)+$/, 'condition fields start with "context." (e.g. context.steps.lookup.total)'), op: z.string().min(1).max(64), value: z.unknown().optional() }).strict(),
  ]),
);

export const NODE_CONFIG_SCHEMAS: Record<NodeType, z.ZodTypeAny> = {
  trigger: z.object({}).passthrough(),
  connector_action: z.object({
    actionKey: z.string().min(1).max(81),
    input: template,
    retry: z.object({ maxAttempts: z.number().int().min(1).max(10), backoffSeconds: z.number().int().min(1).max(3600) }).optional(),
  }),
  ai_step: z.object({
    instructions: z.string().min(1).max(20_000),
    input: template,
    outputSchema: jsonSchemaSchema.refine((s) => s.type === "object", "AI step output schema must be an object"),
    dataClassification: z.enum(["public", "internal", "confidential", "restricted"]).default("internal"),
    model: z.string().max(120).optional(),
    maxTokens: z.number().int().min(100).max(16_000).default(2_000),
  }),
  transform: z.union([z.object({ mappings: mappingsSchema }), z.object({ transformationId: z.string().uuid() })]),
  condition: z.object({ condition: conditionSchema }),
  human_approval: z.object({
    title: z.string().min(1).max(200),
    reason: z.string().min(1).max(1000),
    risk: z.enum(RISK_LEVELS).default("medium"),
    businessImpact: z.string().max(1000).optional(),
    payload: template,
    expiresHours: z.number().int().min(1).max(720).default(72),
  }),
  delay: z.object({ seconds: z.number().int().min(1).max(30 * 24 * 3600) }),
  retry: z.object({ maxAttempts: z.number().int().min(1).max(10), backoffSeconds: z.number().int().min(1).max(3600) }),
  branch: z.object({ path: z.string().min(1).max(300) }),
  exception_handler: z.object({ compensate: z.boolean().default(false), notify: z.boolean().default(true) }),
  completion: z.object({ output: template }),
};

/** Which outgoing edge kinds each node type may have: [kind, min, max]. */
const EDGE_RULES: Record<NodeType, Array<[EdgeKind, number, number]>> = {
  trigger: [["next", 1, 1]],
  connector_action: [["next", 0, 1], ["error", 0, 1]],
  ai_step: [["next", 0, 1], ["error", 0, 1]],
  transform: [["next", 0, 1], ["error", 0, 1]],
  condition: [["true", 1, 1], ["false", 1, 1]],
  human_approval: [["next", 1, 1], ["rejected", 0, 1]],
  delay: [["next", 1, 1]],
  retry: [["next", 1, 1]],
  branch: [["case", 1, 50], ["next", 0, 1]],
  exception_handler: [["next", 0, 1]],
  completion: [],
};

export const nodeSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, "node keys are a-z, 0-9, _ (start with a letter)"),
  type: z.enum(NODE_TYPES),
  name: z.string().trim().min(1).max(200),
  config: z.record(z.unknown()).default({}),
  position: z.object({ x: z.number().min(-1e5).max(1e5), y: z.number().min(-1e5).max(1e5) }).default({ x: 0, y: 0 }),
});
export const edgeSchema = z.object({ from: z.string().max(64), to: z.string().max(64), kind: z.enum(EDGE_KINDS).default("next"), label: z.string().max(120).nullish() });
export const graphSchema = z.object({ nodes: z.array(nodeSchema).max(200), edges: z.array(edgeSchema).max(600) });

export interface GraphIssue {
  node?: string;
  message: string;
}

/** Full validation. `actionKeys` = active action keys in the org (unknown → issue). */
export function validateGraph(nodes: NodeDef[], edges: EdgeDef[], actionKeys?: Set<string>): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const byKey = new Map<string, NodeDef>();
  for (const n of nodes) {
    if (byKey.has(n.key)) issues.push({ node: n.key, message: "duplicate node key" });
    byKey.set(n.key, n);
    const cfg = NODE_CONFIG_SCHEMAS[n.type].safeParse(n.config);
    if (!cfg.success) for (const i of cfg.error.issues.slice(0, 5)) issues.push({ node: n.key, message: `config ${i.path.join(".") || ""}: ${i.message}`.replace(" : ", ": ") });
    if (n.type === "connector_action" && actionKeys && cfg.success && !actionKeys.has((cfg.data as { actionKey: string }).actionKey)) {
      issues.push({ node: n.key, message: `action "${(n.config as { actionKey?: string }).actionKey}" does not exist or is disabled` });
    }
  }
  const triggers = nodes.filter((n) => n.type === "trigger");
  if (triggers.length !== 1) issues.push({ message: `a workflow needs exactly one trigger (found ${triggers.length})` });
  if (!nodes.some((n) => n.type === "completion")) issues.push({ message: "a workflow needs at least one completion node" });

  const seen = new Set<string>();
  for (const e of edges) {
    if (!byKey.has(e.from) || !byKey.has(e.to)) {
      issues.push({ message: `edge ${e.from} → ${e.to} references an unknown node` });
      continue;
    }
    if (e.from === e.to) issues.push({ node: e.from, message: "a node cannot connect to itself" });
    const id = `${e.from}|${e.to}|${e.kind}`;
    if (seen.has(id)) issues.push({ node: e.from, message: `duplicate ${e.kind} edge to ${e.to}` });
    seen.add(id);
    if (byKey.get(e.to)!.type === "trigger") issues.push({ node: e.to, message: "nothing may connect into the trigger" });
  }
  for (const n of nodes) {
    const out = edges.filter((e) => e.from === n.key);
    const rules = EDGE_RULES[n.type];
    for (const e of out) if (!rules.some(([k]) => k === e.kind)) issues.push({ node: n.key, message: `${n.type} nodes cannot have "${e.kind}" edges` });
    for (const [kind, min, max] of rules) {
      const c = out.filter((e) => e.kind === kind).length;
      if (c < min) issues.push({ node: n.key, message: `needs ${min === max ? "a" : `at least ${min}`} "${kind}" edge` });
      if (c > max) issues.push({ node: n.key, message: `may have at most ${max} "${kind}" edge(s)` });
    }
    if (n.type === "branch") {
      const labels = out.filter((e) => e.kind === "case").map((e) => e.label ?? "");
      if (labels.some((l) => !l)) issues.push({ node: n.key, message: "every case edge needs a label (the value to match)" });
      if (new Set(labels).size !== labels.length) issues.push({ node: n.key, message: "case labels must be unique" });
    }
    if (n.type === "retry") {
      const target = out[0] && byKey.get(out[0].to);
      if (target && target.type !== "connector_action" && target.type !== "ai_step") issues.push({ node: n.key, message: "a retry node must lead to a connector action or AI step" });
    }
    if (n.type === "exception_handler" && !edges.some((e) => e.to === n.key && e.kind === "error")) issues.push({ node: n.key, message: "an exception handler must be reached through an error edge" });
  }

  // Reachability and cycles (executions must terminate).
  const trigger = triggers[0];
  if (trigger) {
    const reach = new Set<string>([trigger.key]);
    const stack = [trigger.key];
    while (stack.length) {
      const k = stack.pop()!;
      for (const e of edges) if (e.from === k && !reach.has(e.to) && byKey.has(e.to)) {
        reach.add(e.to);
        stack.push(e.to);
      }
    }
    for (const n of nodes) if (!reach.has(n.key)) issues.push({ node: n.key, message: "not reachable from the trigger" });
  }
  if (hasCycle(nodes, edges)) issues.push({ message: "the workflow contains a cycle — use retry nodes instead of loops" });
  return issues;
}

function hasCycle(nodes: NodeDef[], edges: EdgeDef[]) {
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (k: string): boolean => {
    if (state.get(k) === 1) return true;
    if (state.get(k) === 2) return false;
    state.set(k, 1);
    for (const e of edges) if (e.from === k && visit(e.to)) return true;
    state.set(k, 2);
    return false;
  };
  return nodes.some((n) => visit(n.key));
}

/** Next node for an edge kind (and, for branches, a case value). */
export function nextNode(edges: EdgeDef[], from: string, kind: EdgeKind, caseValue?: string): string | null {
  if (kind === "case") {
    const hit = edges.find((e) => e.from === from && e.kind === "case" && e.label === caseValue);
    if (hit) return hit.to;
    return edges.find((e) => e.from === from && e.kind === "next")?.to ?? null;
  }
  return edges.find((e) => e.from === from && e.kind === kind)?.to ?? null;
}
