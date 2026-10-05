import { z } from "zod";
import { STEP_TYPES, type StepType } from "./schema";

/**
 * AI redesign: prompt construction, response validation, and the
 * human-control guard. The model call itself goes through the shared AI
 * service (see service.ts) — this file never talks to a provider.
 */

export const REDESIGN_PROMPT = { id: "workflow.redesign", version: "1" } as const;

export interface CurrentStep {
  key: string;
  type: StepType;
  name: string;
  description: string;
  role: string | null;
  system: string | null;
  durationMinutes: number;
  waitMinutes: number;
  requiresApproval: boolean;
  risk: string;
}

export interface RedesignContext {
  name: string;
  description: string;
  department: string | null;
  riskCategory: string;
  regulatoryCategory: string | null;
  annualVolume: number;
  steps: CurrentStep[];
  edges: Array<{ from: string; to: string; label?: string | null }>;
}

export const REDESIGN_SYSTEM = [
  "You are a business-process redesign analyst. You propose how AI could improve an existing workflow.",
  "Rules:",
  "- Respond with ONE JSON object matching the schema in the user message. No prose outside JSON.",
  "- Keep every approval step and every step marked requiresApproval. You may add AI preparation before them but never remove or automate the human decision.",
  "- Keep step keys of retained steps unchanged. New steps get new unique keys (lowercase, a-z0-9_).",
  "- Every removed step must be listed in removedSteps with a reason.",
  "- Include exception paths for what happens when the AI output is low-confidence or wrong.",
  "- All numbers you produce are estimates; be conservative and explain them.",
].join("\n");

const stepSchema = z.object({
  key: z.string().regex(/^[a-z0-9_-]{1,64}$/),
  type: z.enum(STEP_TYPES),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(""),
  role: z.string().max(120).nullish(),
  system: z.string().max(120).nullish(),
  durationMinutes: z.number().min(0).max(100_000).default(0),
  requiresApproval: z.boolean().default(false),
  change: z.enum(["kept", "modified", "added", "automated"]).default("kept"),
  rationale: z.string().max(1000).default(""),
});

export const redesignResponseSchema = z.object({
  summary: z.string().min(1).max(4000),
  futureSteps: z.array(stepSchema).min(1).max(200),
  futureEdges: z.array(z.object({ from: z.string().max(64), to: z.string().max(64), label: z.string().max(120).nullish() })).max(400).default([]),
  removedSteps: z.array(z.object({ key: z.string().max(64), reason: z.string().max(1000) })).max(200).default([]),
  exceptionPaths: z.array(z.object({ trigger: z.string().max(500), handling: z.string().max(1000) })).max(50).default([]),
  requirements: z
    .object({
      integration: z.array(z.string().max(500)).max(50).default([]),
      data: z.array(z.string().max(500)).max(50).default([]),
      security: z.array(z.string().max(500)).max(50).default([]),
    })
    .default({}),
  estimates: z.object({
    timeReductionPct: z.number().min(0).max(100),
    costReductionPct: z.number().min(0).max(100),
    rationale: z.string().max(2000).default(""),
  }),
  confidence: z.enum(["low", "medium", "high"]).default("medium"),
});
export type RedesignResponse = z.infer<typeof redesignResponseSchema>;

export function buildRedesignPrompt(c: RedesignContext): string {
  return [
    "Redesign this workflow with AI where it creates value. Current state:",
    JSON.stringify({
      workflow: { name: c.name, description: c.description, department: c.department, riskCategory: c.riskCategory, regulatoryCategory: c.regulatoryCategory, annualVolume: c.annualVolume },
      steps: c.steps,
      edges: c.edges,
    }),
    "Respond with JSON of this shape:",
    JSON.stringify({
      summary: "string",
      futureSteps: [{ key: "string", type: STEP_TYPES.join("|"), name: "string", description: "string", role: "string|null", system: "string|null", durationMinutes: 0, requiresApproval: false, change: "kept|modified|added|automated", rationale: "string" }],
      futureEdges: [{ from: "key", to: "key", label: "string|null" }],
      removedSteps: [{ key: "string", reason: "string" }],
      exceptionPaths: [{ trigger: "string", handling: "string" }],
      requirements: { integration: ["string"], data: ["string"], security: ["string"] },
      estimates: { timeReductionPct: 0, costReductionPct: 0, rationale: "string" },
      confidence: "low|medium|high",
    }),
  ].join("\n\n");
}

export interface RedesignProposal extends RedesignResponse {
  /** Derived views for the reviewer. */
  aiSteps: string[];
  humanApprovals: string[];
  /** The numbers above are model estimates, never facts. */
  provenance: "ai_estimate";
  restoredControls: string[];
}

/** Extract the first JSON object from a model reply (tolerates code fences). */
export function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON object in response");
  return JSON.parse(trimmed.slice(start, end + 1));
}

/**
 * Validate a redesign against the current state. Necessary human controls
 * are NEVER silently removed: any approval step (or step requiring approval)
 * that the model dropped or automated is restored, and a warning explains
 * what was put back. Dangling edges are dropped with a warning.
 */
export function guardRedesign(current: RedesignContext, raw: RedesignResponse): { proposal: RedesignProposal; warnings: string[] } {
  const warnings: string[] = [];
  const future = raw.futureSteps.map((s) => ({ ...s }));
  const seen = new Set<string>();
  for (let i = future.length - 1; i >= 0; i--) {
    if (seen.has(future[i]!.key)) {
      warnings.push(`Duplicate future step key "${future[i]!.key}" removed.`);
      future.splice(i, 1);
    } else seen.add(future[i]!.key);
  }
  let removed = raw.removedSteps.filter((r) => current.steps.some((s) => s.key === r.key));
  const edges = [...raw.futureEdges];
  const restored: string[] = [];

  for (const step of current.steps) {
    if (step.type !== "approval" && !step.requiresApproval) continue;
    const f = future.find((x) => x.key === step.key);
    if (f && (f.type === "approval" || f.requiresApproval)) continue;
    if (f) {
      f.requiresApproval = true;
      if (step.type === "approval") f.type = "approval";
      f.rationale = `${f.rationale ? `${f.rationale} ` : ""}[Guard] Human approval retained — the proposal had automated this control.`.trim();
      warnings.push(`"${step.name}" is a human control; the proposal automated it. The approval has been kept.`);
    } else {
      future.push({ key: step.key, type: step.type, name: step.name, description: step.description, role: step.role, system: step.system, durationMinutes: step.durationMinutes, requiresApproval: true, change: "kept", rationale: "[Guard] Restored: necessary human control removed by the proposal." });
      for (const e of current.edges) if (e.from === step.key || e.to === step.key) edges.push({ from: e.from, to: e.to, label: e.label ?? null });
      warnings.push(`"${step.name}" is a human control; the proposal removed it. It has been restored — review its connections.`);
    }
    removed = removed.filter((r) => r.key !== step.key);
    restored.push(step.key);
  }

  const keys = new Set(future.map((s) => s.key));
  const dedup = new Map<string, (typeof edges)[number]>();
  for (const e of edges) {
    if (!keys.has(e.from) || !keys.has(e.to)) {
      warnings.push(`Edge ${e.from} → ${e.to} references a step that is not in the future state and was dropped.`);
      continue;
    }
    dedup.set(`${e.from}→${e.to}`, e);
  }
  if (current.steps.some((s) => s.type === "exception") && raw.exceptionPaths.length === 0) warnings.push("The current workflow has exception handling but the proposal defines no exception paths.");
  if (future.some((s) => s.type === "ai_task") && raw.exceptionPaths.length === 0) warnings.push("The proposal adds AI steps without an exception path for low-confidence or wrong AI output.");
  const missingRemoved = current.steps.filter((s) => !keys.has(s.key) && !removed.some((r) => r.key === s.key));
  for (const s of missingRemoved) {
    removed.push({ key: s.key, reason: "(No reason given by the model.)" });
    warnings.push(`"${s.name}" disappears from the future state without a stated reason.`);
  }

  return {
    proposal: {
      ...raw,
      futureSteps: future,
      futureEdges: [...dedup.values()],
      removedSteps: removed,
      aiSteps: future.filter((s) => s.type === "ai_task").map((s) => s.key),
      humanApprovals: future.filter((s) => s.type === "approval" || s.requiresApproval).map((s) => s.key),
      provenance: "ai_estimate",
      restoredControls: restored,
    },
    warnings,
  };
}
