import { type AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import { type AIService } from "@eaop/ai";
import { type AuditService } from "@eaop/audit";
import { type ConnectorService } from "@eaop/connectors";
import { aiRuns, and, asc, desc, eq, ilike, inArray, memberships, or, scopeOf, sql, type Database, type Tx } from "@eaop/db";
import { type EventBus } from "@eaop/events";
import { type NotificationService } from "@eaop/notifications";
import { type Authorizer } from "@eaop/rbac";
import { AppError, conflict, forbidden, notFound, type TenantContext } from "@eaop/shared-types";
import { mapCsv, splitList } from "./csv";
import { buildRedesignPrompt, extractJson, guardRedesign, REDESIGN_PROMPT, REDESIGN_SYSTEM, redesignResponseSchema, type RedesignContext, type RedesignProposal } from "./redesign";
import { ASSUMPTION_DEFINITIONS, calculateRealized, calculateRoi, MEASUREMENT_KEYS, type RealizedResult, type RoiResult, type TaggedValue } from "./roi";
import { isAiReady, portfolioPosition, RATED_DIMENSIONS, scoreWorkflow, type DimensionKey, type Rating, type ScoringResult } from "./scoring";
import {
  COST_CATEGORIES, COST_PERIODS, DATA_CLASSES, FREQUENCIES, IMPLEMENTATION_STAGES, PROVENANCE, RISK_LEVELS, STEP_TYPES, WORKFLOW_STATUSES,
  wiWorkflowAssumptions, wiWorkflowBaselines, wiWorkflowCosts, wiWorkflowEdges, wiWorkflowImplementations, wiWorkflowMeasurements, wiWorkflowMetrics,
  wiWorkflowOpportunities, wiWorkflowRecommendations, wiWorkflowRoiCalculations, wiWorkflows, wiWorkflowScores, wiWorkflowSteps, wiWorkflowVersions,
  type DataClass, type ImplementationStage,
} from "./schema";

export const MODULE_ID = "workflow_intelligence" as const;

// ── Input schemas ───────────────────────────────────────────────────────────

const text = (max: number) => z.string().trim().max(max);
const list = z.array(z.string().trim().min(1).max(120)).max(50);

export const workflowInputSchema = z.object({
  name: text(200).min(1),
  description: text(5000).default(""),
  department: text(120).nullish(),
  ownerUserId: z.string().uuid().nullish(),
  ownerName: text(200).nullish(),
  businessSponsor: text(200).nullish(),
  status: z.enum(WORKFLOW_STATUSES).default("active"),
  frequency: z.enum(FREQUENCIES).default("daily"),
  annualVolume: z.coerce.number().min(0).max(1e12).default(0),
  systems: list.default([]),
  roles: list.default([]),
  riskCategory: z.enum(RISK_LEVELS).default("medium"),
  regulatoryCategory: text(120).nullish(),
  /** "sample" data is kept apart from production data everywhere. */
  dataClass: z.enum(DATA_CLASSES).default("production"),
});
export type WorkflowInput = z.input<typeof workflowInputSchema>;

export const workflowUpdateSchema = workflowInputSchema.omit({ dataClass: true }).partial().extend({
  /** Stamp last_reviewed_at = now. */
  markReviewed: z.boolean().optional(),
  changeNote: text(500).optional(),
});

export const stepInputSchema = z.object({
  key: z.string().regex(/^[a-z0-9_-]{1,64}$/, "Step keys are 1–64 chars of a-z, 0-9, _ or -"),
  type: z.enum(STEP_TYPES),
  name: text(200).min(1),
  description: text(2000).default(""),
  owner: text(200).nullish(),
  role: text(120).nullish(),
  system: text(120).nullish(),
  input: text(500).nullish(),
  output: text(500).nullish(),
  durationMinutes: z.coerce.number().min(0).max(100_000).default(0),
  waitMinutes: z.coerce.number().min(0).max(1_000_000).default(0),
  frequencyPerRun: z.coerce.number().min(0).max(10_000).default(1),
  costPerExecution: z.coerce.number().min(0).max(1e9).default(0),
  errorRate: z.coerce.number().min(0).max(1).default(0),
  reworkRate: z.coerce.number().min(0).max(1).default(0),
  requiresApproval: z.boolean().default(false),
  risk: z.enum(RISK_LEVELS).default("low"),
  automationPotential: z.enum(["unknown", "none", "low", "medium", "high"]).default("unknown"),
  position: z.object({ x: z.number().min(-100_000).max(100_000), y: z.number().min(-100_000).max(100_000) }).default({ x: 0, y: 0 }),
});

export const graphInputSchema = z.object({
  steps: z.array(stepInputSchema).max(300),
  edges: z.array(z.object({ from: z.string().max(64), to: z.string().max(64), label: text(120).nullish() })).max(1000),
  changeNote: text(500).optional(),
});

export const metricsInputSchema = z.object({
  employeesInvolved: z.coerce.number().int().min(0).max(10_000_000).nullish(),
  factors: z
    .record(z.object({ value: z.coerce.number().int().min(1).max(5), provenance: z.enum(PROVENANCE), note: text(500).optional() }))
    .refine((f) => Object.keys(f).every((k) => (RATED_DIMENSIONS as string[]).includes(k)), { message: `Factors must be one of: ${RATED_DIMENSIONS.join(", ")}` })
    .default({}),
});

export const assumptionsInputSchema = z
  .array(z.object({ key: z.string().max(64), value: z.coerce.number().finite(), provenance: z.enum(PROVENANCE), rationale: text(1000).default("") }))
  .max(50)
  .superRefine((items, c) => {
    for (const [i, a] of items.entries()) {
      const def = ASSUMPTION_DEFINITIONS.find((d) => d.key === a.key);
      if (!def) c.addIssue({ code: "custom", path: [i, "key"], message: `Unknown assumption "${a.key}"` });
      else if (a.value < def.min || a.value > def.max) c.addIssue({ code: "custom", path: [i, "value"], message: `${def.label} must be between ${def.min} and ${def.max}` });
    }
  });

export const costsInputSchema = z
  .array(z.object({ category: z.enum(COST_CATEGORIES), period: z.enum(COST_PERIODS), amount: z.coerce.number().min(0).max(1e12), provenance: z.enum(PROVENANCE), description: text(500).default("") }))
  .max(100);

export const importRecordSchema = z.object({
  externalId: text(200).optional(),
  name: text(200).min(1),
  description: text(5000).optional(),
  department: text(120).optional(),
  ownerName: text(200).optional(),
  businessSponsor: text(200).optional(),
  frequency: z.enum(FREQUENCIES).optional(),
  annualVolume: z.coerce.number().min(0).max(1e12).optional(),
  systems: list.optional(),
  roles: list.optional(),
  riskCategory: z.enum(RISK_LEVELS).optional(),
  regulatoryCategory: text(120).optional(),
});

export const connectorImportSchema = z.object({
  connectorId: z.string().uuid(),
  capability: z.string().min(1).max(120),
  params: z.record(z.unknown()).default({}),
  /** Field in each record to use as the workflow name / external id. */
  nameField: z.string().max(64).default("name"),
  idField: z.string().max(64).default("id"),
});

export const decisionSchema = z.object({ decision: z.enum(["approve", "reject"]), note: text(2000).optional(), strategicPriority: z.coerce.number().int().min(1).max(5).optional() });

const milestoneSchema = z.object({ name: text(200).min(1), dueDate: z.string().date().nullish(), done: z.boolean().default(false) });
export const implementationInputSchema = z.object({
  sponsor: text(200).nullish(),
  owner: text(200).nullish(),
  team: list.default([]),
  milestones: z.array(milestoneSchema).max(100).default([]),
  dependencies: z.array(text(300).min(1)).max(50).default([]),
  systems: list.default([]),
  actualCost: z.coerce.number().min(0).max(1e12).optional(),
  deploymentDate: z.string().date().nullish(),
});

const metricsRecord = z
  .record(z.coerce.number().finite().min(0))
  .refine((m) => Object.keys(m).every((k) => (MEASUREMENT_KEYS as readonly string[]).includes(k)), { message: `Metric keys must be one of: ${MEASUREMENT_KEYS.join(", ")}` })
  .refine((m) => m.error_rate == null || m.error_rate <= 1, { message: "error_rate must be between 0 and 1" });

export const baselineInputSchema = z.object({ periodDays: z.coerce.number().int().min(1).max(3660), metrics: metricsRecord, provenance: z.enum(PROVENANCE) });
export const measurementInputSchema = z
  .object({ periodStart: z.string().date(), periodEnd: z.string().date(), metrics: metricsRecord, provenance: z.enum(PROVENANCE), note: text(1000).optional() })
  .refine((m) => m.periodEnd >= m.periodStart, { message: "periodEnd must be on or after periodStart", path: ["periodEnd"] });

/** Validate input; failures become VALIDATION_FAILED with field-level issues (same envelope as the API layer). */
function parse<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.output<S> {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  throw new AppError("VALIDATION_FAILED", r.error.issues[0]?.message ?? "Request validation failed.", { issues: r.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })) });
}

// ── Views ───────────────────────────────────────────────────────────────────

type WorkflowRow = typeof wiWorkflows.$inferSelect;
type StepRow = typeof wiWorkflowSteps.$inferSelect;
type EdgeRow = typeof wiWorkflowEdges.$inferSelect;
type OpportunityRow = typeof wiWorkflowOpportunities.$inferSelect;
type ImplementationRow = typeof wiWorkflowImplementations.$inferSelect;

export interface WorkflowView {
  id: string;
  name: string;
  description: string;
  department: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  businessSponsor: string | null;
  status: string;
  frequency: string;
  annualVolume: number;
  systems: string[];
  roles: string[];
  riskCategory: "low" | "medium" | "high" | "critical";
  regulatoryCategory: string | null;
  source: string;
  sourceRef: string | null;
  connectorId: string | null;
  dataClass: DataClass;
  currentVersion: number;
  lastReviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type StepView = Omit<StepRow, "organizationId" | "workflowId" | "id"> & { id: string };
export interface EdgeView {
  from: string;
  to: string;
  label: string | null;
}

export interface WorkflowSummary extends WorkflowView {
  analyzed: boolean;
  scores: { aiOpportunity: number; automationReadiness: number; dataReadiness: number; risk: number; integrationComplexity: number; expectedRoi: number } | null;
  aiReady: boolean;
  quadrant: string | null;
  stepCount: number;
}

export interface StoredScores extends ScoringResult {
  position: ReturnType<typeof portfolioPosition>;
  aiReady: boolean;
  workflowVersion: number;
  computedAt: string;
  /** True when the workflow changed after these scores were computed. */
  stale: boolean;
}

export interface OpportunityView {
  id: string;
  workflowId: string;
  workflowName: string;
  department: string | null;
  dataClass: DataClass;
  status: string;
  valueScore: number;
  complexityScore: number;
  riskScore: number;
  quadrant: string;
  strategicPriority: number;
  /** Financial fields are null unless the viewer holds workflow.roi.read. */
  estimatedAnnualSavings: number | null;
  potentialRevenue: number | null;
  implementationCost: number | null;
  paybackMonths: number | null;
  roi3yrPct: number | null;
  laborHoursRecoverable: number;
  createdBy: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  implementationId: string | null;
  updatedAt: string;
}

export interface ImplementationView {
  id: string;
  opportunityId: string;
  workflowId: string;
  workflowName: string;
  dataClass: DataClass;
  stage: ImplementationStage;
  sponsor: string | null;
  owner: string | null;
  team: string[];
  milestones: Array<{ name: string; dueDate?: string | null; done: boolean }>;
  dependencies: string[];
  systems: string[];
  expectedAnnualSavings: number | null;
  actualCost: number | null;
  deploymentDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecommendationView {
  id: string;
  workflowId: string;
  workflowVersion: number;
  status: string;
  proposal: RedesignProposal;
  warnings: string[];
  promptTemplateId: string;
  promptTemplateVersion: string;
  ai: { runId: string | null; provider: string | null; model: string | null; status: string | null; inputTokens: number | null; outputTokens: number | null; estimatedCostUsd: number | null };
  createdBy: string | null;
  createdAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
}

export interface WorkflowDetail {
  workflow: WorkflowView;
  steps: StepView[];
  edges: EdgeView[];
  metrics: { employeesInvolved: number | null; factors: Partial<Record<DimensionKey, Rating>> };
  assumptions: Array<{ key: string; label: string; unit: string; description: string; value: number; provenance: string; rationale: string; defaulted: boolean; min: number; max: number }>;
  costs: Array<{ id: string; category: string; period: string; amount: number; provenance: string; description: string }>;
  /** Live projection from current inputs (null without workflow.roi.read). */
  roi: RoiResult | null;
  scores: StoredScores | null;
  opportunity: OpportunityView | null;
  implementation: ImplementationView | null;
  recommendations: RecommendationView[];
  canSeeFinancials: boolean;
}

export interface DashboardView {
  dataClass: DataClass;
  canSeeFinancials: boolean;
  totals: {
    workflows: number;
    analyzed: number;
    highValueOpportunities: number;
    aiReady: number;
    activeImplementations: number;
    laborHoursRecoverable: number;
    estimatedAnnualSavings: number | null;
    potentialRevenue: number | null;
    implementationInvestment: number | null;
    projectedRoi3yrPct: number | null;
    realizedRoiPct: number | null;
    realizedAnnualSavings: number | null;
  };
  byDepartment: Array<{ label: string; workflows: number; savings: number | null }>;
  byReadiness: Array<{ label: string; value: number }>;
  byRisk: Array<{ label: string; value: number }>;
  byComplexity: Array<{ label: string; value: number }>;
  quadrants: Array<{ label: string; value: number }>;
  projectedVsActual: Array<{ implementationId: string; workflowName: string; stage: string; projected: number | null; actual: number | null }>;
  formulas: Record<string, string>;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const userId = (ctx: TenantContext) => (ctx.actor.type === "user" ? ctx.actor.id : null);

const workflowView = (w: WorkflowRow): WorkflowView => ({
  id: w.id, name: w.name, description: w.description, department: w.department, ownerUserId: w.ownerUserId, ownerName: w.ownerName,
  businessSponsor: w.businessSponsor, status: w.status, frequency: w.frequency, annualVolume: Number(w.annualVolume), systems: w.systems, roles: w.roles,
  riskCategory: w.riskCategory, regulatoryCategory: w.regulatoryCategory, source: w.source, sourceRef: w.sourceRef, connectorId: w.connectorId,
  dataClass: w.dataClass, currentVersion: w.currentVersion, lastReviewedAt: iso(w.lastReviewedAt), createdAt: w.createdAt.toISOString(), updatedAt: w.updatedAt.toISOString(),
});

const stepView = (s: StepRow): StepView => {
  const { organizationId: _o, workflowId: _w, ...rest } = s;
  return rest;
};
const edgeView = (e: EdgeRow): EdgeView => ({ from: e.fromKey, to: e.toKey, label: e.label });

const STAGE_INDEX = Object.fromEntries(IMPLEMENTATION_STAGES.map((s, i) => [s, i])) as Record<ImplementationStage, number>;
const ACTIVE_STAGES: ImplementationStage[] = ["approved", "design", "build", "testing", "pilot", "production"];

// ── Service ─────────────────────────────────────────────────────────────────

export interface WorkflowService {
  list(ctx: TenantContext, q?: { dataClass?: DataClass; department?: string; status?: string; riskCategory?: string; q?: string }): Promise<WorkflowSummary[]>;
  get(ctx: TenantContext, id: string): Promise<WorkflowDetail>;
  create(ctx: TenantContext, input: WorkflowInput): Promise<WorkflowView>;
  update(ctx: TenantContext, id: string, input: z.input<typeof workflowUpdateSchema>): Promise<WorkflowView>;
  remove(ctx: TenantContext, id: string): Promise<void>;
  saveGraph(ctx: TenantContext, id: string, input: z.input<typeof graphInputSchema>): Promise<{ version: number }>;
  listVersions(ctx: TenantContext, id: string): Promise<Array<{ version: number; changeNote: string | null; createdBy: string | null; createdAt: string; stepCount: number }>>;
  getVersion(ctx: TenantContext, id: string, version: number): Promise<{ version: number; snapshot: Record<string, unknown>; changeNote: string | null; createdAt: string }>;
  setMetrics(ctx: TenantContext, id: string, input: z.input<typeof metricsInputSchema>): Promise<void>;
  setAssumptions(ctx: TenantContext, id: string, input: z.input<typeof assumptionsInputSchema>): Promise<void>;
  setCosts(ctx: TenantContext, id: string, input: z.input<typeof costsInputSchema>): Promise<void>;
  importCsv(ctx: TenantContext, csv: string, opts?: { dataClass?: DataClass }): Promise<ImportResult>;
  importRecords(ctx: TenantContext, records: unknown[], opts?: { dataClass?: DataClass }): Promise<ImportResult>;
  importFromConnector(ctx: TenantContext, input: z.input<typeof connectorImportSchema>): Promise<ImportResult & { simulated: boolean }>;
  loadSampleData(ctx: TenantContext): Promise<{ created: number }>;
  clearSampleData(ctx: TenantContext): Promise<{ deleted: number }>;
  analyze(ctx: TenantContext, id: string): Promise<{ scores: StoredScores; roi: RoiResult; opportunity: OpportunityView }>;
  redesign(ctx: TenantContext, id: string): Promise<RecommendationView>;
  reviewRecommendation(ctx: TenantContext, id: string, input: { decision: "accept" | "reject"; note?: string }): Promise<RecommendationView>;
  listOpportunities(ctx: TenantContext, q?: { dataClass?: DataClass; status?: string; quadrant?: string; department?: string; sort?: "value" | "savings" | "roi" | "priority" | "risk" }): Promise<OpportunityView[]>;
  decideOpportunity(ctx: TenantContext, id: string, input: z.input<typeof decisionSchema>): Promise<OpportunityView>;
  startImplementation(ctx: TenantContext, opportunityId: string, input: z.input<typeof implementationInputSchema>): Promise<ImplementationView>;
  listImplementations(ctx: TenantContext, q?: { dataClass?: DataClass; stage?: string }): Promise<ImplementationView[]>;
  getImplementation(ctx: TenantContext, id: string): Promise<ImplementationDetail>;
  updateImplementation(ctx: TenantContext, id: string, input: Partial<z.input<typeof implementationInputSchema>>): Promise<ImplementationView>;
  advanceStage(ctx: TenantContext, id: string, stage: ImplementationStage, note?: string): Promise<ImplementationView>;
  recordBaseline(ctx: TenantContext, id: string, input: z.input<typeof baselineInputSchema>): Promise<void>;
  recordMeasurement(ctx: TenantContext, id: string, input: z.input<typeof measurementInputSchema>): Promise<{ measurementId: string; realized: RealizedResult }>;
  dashboard(ctx: TenantContext, q?: { dataClass?: DataClass }): Promise<DashboardView>;
}

export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ line?: number; index?: number; message: string }>;
  dataClass: DataClass;
}

export interface ImplementationDetail extends ImplementationView {
  baseline: { periodDays: number; metrics: Record<string, number>; provenance: string; capturedAt: string } | null;
  measurements: Array<{ id: string; periodStart: string; periodEnd: string; metrics: Record<string, number>; provenance: string; note: string | null; createdAt: string }>;
  realized: RealizedResult | null;
  projected: { annualSavings: number | null; laborHoursRecoverable: number | null; netAnnualBenefit: number | null; roi3yrPct: number | null; paybackMonths: number | null } | null;
}

export interface WorkflowServiceDeps {
  db: Database;
  authorizer: Authorizer;
  audit: AuditService;
  bus: EventBus;
  notifications: NotificationService;
  ai: AIService;
  connectors: ConnectorService;
}

const BASE = "/m/workflow-intelligence";

export function createWorkflowService(deps: WorkflowServiceDeps): WorkflowService {
  const { db, authorizer, audit, bus, notifications, ai, connectors } = deps;
  const tenant = <T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>) => db.withTenant(scopeOf(ctx), fn);
  const org = (ctx: TenantContext) => ctx.organizationId;
  const record = (ctx: TenantContext, action: string, resourceType: string, resourceId: string, extra: { before?: unknown; after?: unknown; metadata?: Record<string, unknown> } = {}) =>
    audit.record(ctx, { module: MODULE_ID, action, resourceType, resourceId, ...extra });

  async function loadWorkflow(tx: Tx, ctx: TenantContext, id: string) {
    if (!z.string().uuid().safeParse(id).success) throw notFound("Workflow", id);
    const [w] = await tx.select().from(wiWorkflows).where(and(eq(wiWorkflows.organizationId, org(ctx)), eq(wiWorkflows.id, id))).limit(1);
    if (!w) throw notFound("Workflow", id);
    return w;
  }

  async function loadModel(tx: Tx, ctx: TenantContext, w: WorkflowRow) {
    const where = (t: { organizationId: AnyPgColumn; workflowId: AnyPgColumn }) => and(eq(t.organizationId, org(ctx)), eq(t.workflowId, w.id));
    // Sequential on purpose: one transaction = one connection, which cannot run queries concurrently.
    const steps = await tx.select().from(wiWorkflowSteps).where(where(wiWorkflowSteps)).orderBy(asc(wiWorkflowSteps.sort), asc(wiWorkflowSteps.key));
    const edges = await tx.select().from(wiWorkflowEdges).where(where(wiWorkflowEdges));
    const metricsRows = await tx.select().from(wiWorkflowMetrics).where(where(wiWorkflowMetrics)).limit(1);
    const assumptions = await tx.select().from(wiWorkflowAssumptions).where(where(wiWorkflowAssumptions));
    const costs = await tx.select().from(wiWorkflowCosts).where(where(wiWorkflowCosts));
    return { steps, edges, metrics: metricsRows[0] ?? null, assumptions, costs };
  }

  function computeRoi(w: WorkflowRow, m: Awaited<ReturnType<typeof loadModel>>): RoiResult {
    const assumptions: Record<string, TaggedValue> = {};
    for (const a of m.assumptions) assumptions[a.key] = { value: Number(a.value), provenance: a.provenance, rationale: a.rationale };
    return calculateRoi({
      annualVolume: Number(w.annualVolume),
      steps: m.steps.map((s) => ({ key: s.key, name: s.name, type: s.type, durationMinutes: Number(s.durationMinutes), frequencyPerRun: Number(s.frequencyPerRun), costPerExecution: Number(s.costPerExecution), errorRate: Number(s.errorRate), reworkRate: Number(s.reworkRate), automationPotential: s.automationPotential, requiresApproval: s.requiresApproval })),
      costs: m.costs.map((c) => ({ category: c.category, period: c.period, amount: Number(c.amount), provenance: c.provenance, description: c.description })),
      assumptions,
    });
  }

  function computeScores(w: WorkflowRow, m: Awaited<ReturnType<typeof loadModel>>, roi: RoiResult) {
    const result = scoreWorkflow({
      annualVolume: Number(w.annualVolume),
      riskCategory: w.riskCategory,
      systems: w.systems,
      steps: m.steps.map((s) => ({ type: s.type, role: s.role, system: s.system, durationMinutes: Number(s.durationMinutes), frequencyPerRun: Number(s.frequencyPerRun), sort: s.sort })),
      ratings: (m.metrics?.factors ?? {}) as Partial<Record<DimensionKey, Rating>>,
      roi,
    });
    return { ...result, position: portfolioPosition(result.scores), aiReady: isAiReady(result.scores) };
  }

  async function snapshot(tx: Tx, ctx: TenantContext, w: WorkflowRow) {
    const m = await loadModel(tx, ctx, w);
    return {
      workflow: workflowView(w),
      steps: m.steps.map(stepView),
      edges: m.edges.map(edgeView),
      metrics: m.metrics ? { employeesInvolved: m.metrics.employeesInvolved, factors: m.metrics.factors } : null,
    };
  }

  /** Bump current_version atomically and store an immutable snapshot. */
  async function newVersion(tx: Tx, ctx: TenantContext, id: string, changeNote: string | null) {
    const [w] = await tx
      .update(wiWorkflows)
      .set({ currentVersion: sql`${wiWorkflows.currentVersion} + 1`, updatedAt: new Date() })
      .where(and(eq(wiWorkflows.organizationId, org(ctx)), eq(wiWorkflows.id, id)))
      .returning();
    await tx.insert(wiWorkflowVersions).values({ organizationId: org(ctx), workflowId: id, version: w!.currentVersion, snapshot: await snapshot(tx, ctx, w!), changeNote, createdBy: userId(ctx) });
    return w!;
  }

  async function assertMember(tx: Tx, ctx: TenantContext, uid: string | null | undefined) {
    if (!uid) return;
    const [m] = await tx.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.organizationId, org(ctx)), eq(memberships.userId, uid), eq(memberships.status, "active"))).limit(1);
    if (!m) throw new AppError("VALIDATION_FAILED", "Owner must be an active member of this organization.", { field: "ownerUserId" });
  }

  async function insertWorkflow(tx: Tx, ctx: TenantContext, input: z.output<typeof workflowInputSchema>, source: { source: "manual" | "csv" | "api" | "connector"; sourceRef?: string | null; connectorId?: string | null }) {
    await assertMember(tx, ctx, input.ownerUserId);
    const [w] = await tx
      .insert(wiWorkflows)
      .values({ ...input, organizationId: org(ctx), ...source, currentVersion: 1, createdBy: userId(ctx) })
      .returning();
    await tx.insert(wiWorkflowVersions).values({ organizationId: org(ctx), workflowId: w!.id, version: 1, snapshot: await snapshot(tx, ctx, w!), changeNote: `Created (${source.source})`, createdBy: userId(ctx) });
    await record(ctx, "workflow.created", "workflow", w!.id, { after: { name: w!.name, source: w!.source, dataClass: w!.dataClass } });
    await bus.publish(ctx, "workflow.created", { workflowId: w!.id, name: w!.name, source: w!.source, dataClass: w!.dataClass });
    return w!;
  }

  async function latestScores(tx: Tx, ctx: TenantContext, workflowIds: string[]) {
    if (workflowIds.length === 0) return new Map<string, typeof wiWorkflowScores.$inferSelect>();
    const rows = await tx
      .selectDistinctOn([wiWorkflowScores.workflowId])
      .from(wiWorkflowScores)
      .where(and(eq(wiWorkflowScores.organizationId, org(ctx)), inArray(wiWorkflowScores.workflowId, workflowIds)))
      .orderBy(wiWorkflowScores.workflowId, desc(wiWorkflowScores.computedAt));
    return new Map(rows.map((r) => [r.workflowId, r]));
  }

  const storedScores = (row: typeof wiWorkflowScores.$inferSelect, w: WorkflowRow): StoredScores => {
    const s = row.scores as unknown as Omit<StoredScores, "workflowVersion" | "computedAt" | "stale">;
    return { ...s, workflowVersion: row.workflowVersion, computedAt: row.computedAt.toISOString(), stale: row.workflowVersion < w.currentVersion };
  };

  const opportunityView = (o: OpportunityRow, w: Pick<WorkflowRow, "name" | "department" | "dataClass">, fin: boolean, implementationId: string | null): OpportunityView => ({
    id: o.id, workflowId: o.workflowId, workflowName: w.name, department: w.department, dataClass: w.dataClass, status: o.status,
    valueScore: Number(o.valueScore), complexityScore: Number(o.complexityScore), riskScore: Number(o.riskScore), quadrant: o.quadrant, strategicPriority: o.strategicPriority,
    estimatedAnnualSavings: fin ? Number(o.estimatedAnnualSavings) : null,
    potentialRevenue: fin ? Number(o.potentialRevenue) : null,
    implementationCost: fin ? Number(o.implementationCost) : null,
    paybackMonths: fin && o.paybackMonths != null ? Number(o.paybackMonths) : null,
    roi3yrPct: fin && o.roi3yrPct != null ? Number(o.roi3yrPct) : null,
    laborHoursRecoverable: Number(o.laborHoursRecoverable),
    createdBy: o.createdBy, decidedBy: o.decidedBy, decidedAt: iso(o.decidedAt), decisionNote: o.decisionNote, implementationId, updatedAt: o.updatedAt.toISOString(),
  });

  const implementationView = (i: ImplementationRow, w: Pick<WorkflowRow, "name" | "dataClass">, fin: boolean): ImplementationView => ({
    id: i.id, opportunityId: i.opportunityId, workflowId: i.workflowId, workflowName: w.name, dataClass: w.dataClass, stage: i.stage, sponsor: i.sponsor, owner: i.owner,
    team: i.team, milestones: i.milestones, dependencies: i.dependencies, systems: i.systems,
    expectedAnnualSavings: fin ? Number(i.expectedAnnualSavings) : null, actualCost: fin ? Number(i.actualCost) : null,
    deploymentDate: i.deploymentDate, createdAt: i.createdAt.toISOString(), updatedAt: i.updatedAt.toISOString(),
  });

  async function recommendationViews(tx: Tx, ctx: TenantContext, where: ReturnType<typeof eq>): Promise<RecommendationView[]> {
    const rows = await tx
      .select({ r: wiWorkflowRecommendations, run: { provider: aiRuns.providerKey, model: aiRuns.modelKey, status: aiRuns.status, inputTokens: aiRuns.inputTokens, outputTokens: aiRuns.outputTokens, cost: aiRuns.estimatedCostUsd } })
      .from(wiWorkflowRecommendations)
      .leftJoin(aiRuns, eq(aiRuns.id, wiWorkflowRecommendations.aiRunId))
      .where(and(eq(wiWorkflowRecommendations.organizationId, org(ctx)), where))
      .orderBy(desc(wiWorkflowRecommendations.createdAt))
      .limit(20);
    return rows.map(({ r, run }) => ({
      id: r.id, workflowId: r.workflowId, workflowVersion: r.workflowVersion, status: r.status, proposal: r.proposal as unknown as RedesignProposal, warnings: r.warnings,
      promptTemplateId: r.promptTemplateId, promptTemplateVersion: r.promptTemplateVersion,
      ai: { runId: r.aiRunId, provider: run?.provider ?? null, model: run?.model ?? null, status: run?.status ?? null, inputTokens: run?.inputTokens ?? null, outputTokens: run?.outputTokens ?? null, estimatedCostUsd: run?.cost != null ? Number(run.cost) : null },
      createdBy: r.createdBy, createdAt: r.createdAt.toISOString(), reviewedBy: r.reviewedBy, reviewedAt: iso(r.reviewedAt), reviewNote: r.reviewNote,
    }));
  }

  async function upsertImported(tx: Tx, ctx: TenantContext, rec: z.output<typeof importRecordSchema>, source: "csv" | "api" | "connector", dataClass: DataClass, connectorId: string | null): Promise<"created" | "updated" | "skipped"> {
    const ref = rec.externalId ?? null;
    let existing: WorkflowRow | undefined;
    if (ref) {
      [existing] = await tx
        .select()
        .from(wiWorkflows)
        .where(and(eq(wiWorkflows.organizationId, org(ctx)), eq(wiWorkflows.source, source), eq(wiWorkflows.sourceRef, ref), connectorId ? eq(wiWorkflows.connectorId, connectorId) : sql`${wiWorkflows.connectorId} is null`))
        .limit(1);
    } else {
      [existing] = await tx.select().from(wiWorkflows).where(and(eq(wiWorkflows.organizationId, org(ctx)), eq(wiWorkflows.dataClass, dataClass), sql`lower(${wiWorkflows.name}) = lower(${rec.name})`)).limit(1);
      if (existing) return "skipped";
    }
    const attrs = {
      name: rec.name,
      ...(rec.description !== undefined ? { description: rec.description } : {}),
      ...(rec.department !== undefined ? { department: rec.department } : {}),
      ...(rec.ownerName !== undefined ? { ownerName: rec.ownerName } : {}),
      ...(rec.businessSponsor !== undefined ? { businessSponsor: rec.businessSponsor } : {}),
      ...(rec.frequency !== undefined ? { frequency: rec.frequency } : {}),
      ...(rec.annualVolume !== undefined ? { annualVolume: rec.annualVolume } : {}),
      ...(rec.systems !== undefined ? { systems: rec.systems } : {}),
      ...(rec.roles !== undefined ? { roles: rec.roles } : {}),
      ...(rec.riskCategory !== undefined ? { riskCategory: rec.riskCategory } : {}),
      ...(rec.regulatoryCategory !== undefined ? { regulatoryCategory: rec.regulatoryCategory } : {}),
    };
    if (existing) {
      if (existing.dataClass !== dataClass) return "skipped";
      await tx.update(wiWorkflows).set({ ...attrs, updatedAt: new Date() }).where(eq(wiWorkflows.id, existing.id));
      await newVersion(tx, ctx, existing.id, `Re-imported (${source})`);
      await record(ctx, "workflow.updated", "workflow", existing.id, { metadata: { source, sourceRef: ref } });
      return "updated";
    }
    await insertWorkflow(tx, ctx, parse(workflowInputSchema, { ...attrs, dataClass }), { source, sourceRef: ref, connectorId });
    return "created";
  }

  async function requireFin(ctx: TenantContext) {
    return authorizer.can(ctx, "workflow.roi.read");
  }

  async function loadImplementation(tx: Tx, ctx: TenantContext, id: string) {
    if (!z.string().uuid().safeParse(id).success) throw notFound("Implementation", id);
    const [row] = await tx
      .select({ i: wiWorkflowImplementations, w: wiWorkflows })
      .from(wiWorkflowImplementations)
      .innerJoin(wiWorkflows, eq(wiWorkflows.id, wiWorkflowImplementations.workflowId))
      .where(and(eq(wiWorkflowImplementations.organizationId, org(ctx)), eq(wiWorkflowImplementations.id, id)))
      .limit(1);
    if (!row) throw notFound("Implementation", id);
    return row;
  }

  async function projectedFor(tx: Tx, ctx: TenantContext, workflowId: string) {
    const [calc] = await tx
      .select()
      .from(wiWorkflowRoiCalculations)
      .where(and(eq(wiWorkflowRoiCalculations.organizationId, org(ctx)), eq(wiWorkflowRoiCalculations.workflowId, workflowId), eq(wiWorkflowRoiCalculations.kind, "projected")))
      .orderBy(desc(wiWorkflowRoiCalculations.createdAt))
      .limit(1);
    if (!calc) return null;
    const o = (calc.outputs as unknown as RoiResult["outputs"]);
    return { annualSavings: o.annualSavings.value, laborHoursRecoverable: o.laborHoursRecoverable.value, netAnnualBenefit: o.netAnnualBenefit.value, roi3yrPct: o.roi3yrPct.value, paybackMonths: o.paybackMonths.value };
  }

  async function realizedFor(tx: Tx, ctx: TenantContext, i: ImplementationRow) {
    const [baseline] = await tx.select().from(wiWorkflowBaselines).where(and(eq(wiWorkflowBaselines.organizationId, org(ctx)), eq(wiWorkflowBaselines.implementationId, i.id))).orderBy(desc(wiWorkflowBaselines.capturedAt)).limit(1);
    const measurements = await tx.select().from(wiWorkflowMeasurements).where(and(eq(wiWorkflowMeasurements.organizationId, org(ctx)), eq(wiWorkflowMeasurements.implementationId, i.id))).orderBy(asc(wiWorkflowMeasurements.periodStart));
    const projected = await projectedFor(tx, ctx, i.workflowId);
    let realized: RealizedResult | null = null;
    if (baseline && measurements.length && projected) {
      const { period_days: periodDays = 0, ...bm } = baseline.metrics;
      realized = calculateRealized({
        baseline: { periodDays, metrics: bm, provenance: baseline.provenance },
        measurements: measurements.map((m) => ({ periodDays: Math.round((Date.parse(m.periodEnd) - Date.parse(m.periodStart)) / 86_400_000) + 1, metrics: m.metrics, provenance: m.provenance })),
        actualImplementationCost: Number(i.actualCost),
        projected,
      });
    }
    return { baseline: baseline ?? null, measurements, projected, realized };
  }

  return {
    async list(ctx, q = {}) {
      await authorizer.require(ctx, "workflow.read");
      return tenant(ctx, async (tx) => {
        const like = q.q ? `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
        const rows = await tx
          .select()
          .from(wiWorkflows)
          .where(
            and(
              eq(wiWorkflows.organizationId, org(ctx)),
              eq(wiWorkflows.dataClass, q.dataClass ?? "production"),
              q.department ? eq(wiWorkflows.department, q.department) : undefined,
              q.status ? eq(wiWorkflows.status, q.status as WorkflowRow["status"]) : undefined,
              q.riskCategory ? eq(wiWorkflows.riskCategory, q.riskCategory as WorkflowRow["riskCategory"]) : undefined,
              like ? or(ilike(wiWorkflows.name, like), ilike(wiWorkflows.description, like), ilike(wiWorkflows.department, like)) : undefined,
            ),
          )
          .orderBy(asc(wiWorkflows.name))
          .limit(2000);
        const ids = rows.map((r) => r.id);
        const scores = await latestScores(tx, ctx, ids);
        const opps = ids.length ? await tx.select({ workflowId: wiWorkflowOpportunities.workflowId, quadrant: wiWorkflowOpportunities.quadrant }).from(wiWorkflowOpportunities).where(and(eq(wiWorkflowOpportunities.organizationId, org(ctx)), inArray(wiWorkflowOpportunities.workflowId, ids))) : [];
        const counts = ids.length
          ? await tx.select({ workflowId: wiWorkflowSteps.workflowId, n: sql<number>`count(*)::int` }).from(wiWorkflowSteps).where(and(eq(wiWorkflowSteps.organizationId, org(ctx)), inArray(wiWorkflowSteps.workflowId, ids))).groupBy(wiWorkflowSteps.workflowId)
          : [];
        const quad = new Map(opps.map((o) => [o.workflowId, o.quadrant]));
        const cnt = new Map(counts.map((c) => [c.workflowId, c.n]));
        return rows.map((w) => {
          const s = scores.get(w.id);
          const sc = s ? storedScores(s, w) : null;
          return {
            ...workflowView(w),
            analyzed: !!s,
            scores: sc ? { aiOpportunity: sc.scores.aiOpportunity.value, automationReadiness: sc.scores.automationReadiness.value, dataReadiness: sc.scores.dataReadiness.value, risk: sc.scores.risk.value, integrationComplexity: sc.scores.integrationComplexity.value, expectedRoi: sc.scores.expectedRoi.value } : null,
            aiReady: sc?.aiReady ?? false,
            quadrant: quad.get(w.id) ?? null,
            stepCount: cnt.get(w.id) ?? 0,
          };
        });
      });
    },

    async get(ctx, id) {
      await authorizer.require(ctx, "workflow.read");
      const fin = await requireFin(ctx);
      return tenant(ctx, async (tx) => {
        const w = await loadWorkflow(tx, ctx, id);
        const m = await loadModel(tx, ctx, w);
        const scoreRow = (await latestScores(tx, ctx, [w.id])).get(w.id);
        const [opp] = await tx.select().from(wiWorkflowOpportunities).where(and(eq(wiWorkflowOpportunities.organizationId, org(ctx)), eq(wiWorkflowOpportunities.workflowId, w.id))).limit(1);
        const [impl] = opp ? await tx.select().from(wiWorkflowImplementations).where(and(eq(wiWorkflowImplementations.organizationId, org(ctx)), eq(wiWorkflowImplementations.opportunityId, opp.id))).limit(1) : [];
        const given = new Map(m.assumptions.map((a) => [a.key, a]));
        return {
          workflow: workflowView(w),
          steps: m.steps.map(stepView),
          edges: m.edges.map(edgeView),
          metrics: { employeesInvolved: m.metrics?.employeesInvolved ?? null, factors: (m.metrics?.factors ?? {}) as Partial<Record<DimensionKey, Rating>> },
          assumptions: fin
            ? ASSUMPTION_DEFINITIONS.map((d) => {
                const a = given.get(d.key);
                return { key: d.key, label: d.label, unit: d.unit, description: d.description, min: d.min, max: d.max, value: a ? Number(a.value) : d.default, provenance: a?.provenance ?? "assumption", rationale: a?.rationale ?? "Platform default — edit to match your organization.", defaulted: !a };
              })
            : [],
          costs: fin ? m.costs.map((c) => ({ id: c.id, category: c.category, period: c.period, amount: Number(c.amount), provenance: c.provenance, description: c.description })) : [],
          roi: fin ? computeRoi(w, m) : null,
          scores: scoreRow ? storedScores(scoreRow, w) : null,
          opportunity: opp ? opportunityView(opp, w, fin, impl?.id ?? null) : null,
          implementation: impl ? implementationView(impl, w, fin) : null,
          recommendations: await recommendationViews(tx, ctx, eq(wiWorkflowRecommendations.workflowId, w.id)),
          canSeeFinancials: fin,
        };
      });
    },

    async create(ctx, raw) {
      await authorizer.require(ctx, "workflow.create");
      const input = parse(workflowInputSchema, raw);
      return tenant(ctx, async (tx) => workflowView(await insertWorkflow(tx, ctx, input, { source: "manual" })));
    },

    async update(ctx, id, raw) {
      await authorizer.require(ctx, "workflow.update", { type: "workflow", id });
      const { markReviewed, changeNote, ...input } = parse(workflowUpdateSchema, raw);
      return tenant(ctx, async (tx) => {
        const before = await loadWorkflow(tx, ctx, id);
        await assertMember(tx, ctx, input.ownerUserId);
        await tx.update(wiWorkflows).set({ ...input, ...(markReviewed ? { lastReviewedAt: new Date() } : {}), updatedAt: new Date() }).where(eq(wiWorkflows.id, id));
        const after = Object.keys(input).length ? await newVersion(tx, ctx, id, changeNote ?? "Attributes updated") : await loadWorkflow(tx, ctx, id);
        await record(ctx, markReviewed && !Object.keys(input).length ? "workflow.reviewed" : "workflow.updated", "workflow", id, { before: workflowView(before), after: workflowView(after) });
        return workflowView(after);
      });
    },

    async remove(ctx, id) {
      await authorizer.require(ctx, "workflow.delete", { type: "workflow", id });
      await tenant(ctx, async (tx) => {
        const w = await loadWorkflow(tx, ctx, id);
        await tx.delete(wiWorkflows).where(eq(wiWorkflows.id, id));
        await record(ctx, "workflow.deleted", "workflow", id, { before: workflowView(w) });
      });
    },

    async saveGraph(ctx, id, raw) {
      await authorizer.require(ctx, "workflow.update", { type: "workflow", id });
      const input = parse(graphInputSchema, raw);
      const keys = new Set<string>();
      for (const s of input.steps) {
        if (keys.has(s.key)) throw new AppError("VALIDATION_FAILED", `Duplicate step key "${s.key}".`, { field: "steps" });
        keys.add(s.key);
      }
      const edgeKeys = new Set<string>();
      for (const e of input.edges) {
        if (!keys.has(e.from) || !keys.has(e.to)) throw new AppError("VALIDATION_FAILED", `Edge ${e.from} → ${e.to} references an unknown step.`, { field: "edges" });
        if (e.from === e.to) throw new AppError("VALIDATION_FAILED", `Edge ${e.from} → ${e.to} connects a step to itself.`, { field: "edges" });
        if (edgeKeys.has(`${e.from}→${e.to}`)) throw new AppError("VALIDATION_FAILED", `Duplicate edge ${e.from} → ${e.to}.`, { field: "edges" });
        edgeKeys.add(`${e.from}→${e.to}`);
      }
      return tenant(ctx, async (tx) => {
        await loadWorkflow(tx, ctx, id);
        const before = await tx.select({ key: wiWorkflowSteps.key }).from(wiWorkflowSteps).where(and(eq(wiWorkflowSteps.organizationId, org(ctx)), eq(wiWorkflowSteps.workflowId, id)));
        await tx.delete(wiWorkflowEdges).where(and(eq(wiWorkflowEdges.organizationId, org(ctx)), eq(wiWorkflowEdges.workflowId, id)));
        await tx.delete(wiWorkflowSteps).where(and(eq(wiWorkflowSteps.organizationId, org(ctx)), eq(wiWorkflowSteps.workflowId, id)));
        if (input.steps.length) await tx.insert(wiWorkflowSteps).values(input.steps.map((s, i) => ({ ...s, organizationId: org(ctx), workflowId: id, sort: i })));
        if (input.edges.length) await tx.insert(wiWorkflowEdges).values(input.edges.map((e) => ({ organizationId: org(ctx), workflowId: id, fromKey: e.from, toKey: e.to, label: e.label ?? null })));
        const w = await newVersion(tx, ctx, id, input.changeNote ?? "Model updated");
        await record(ctx, "workflow.model_saved", "workflow", id, { metadata: { version: w.currentVersion, steps: input.steps.length, edges: input.edges.length, previousSteps: before.length } });
        return { version: w.currentVersion };
      });
    },

    async listVersions(ctx, id) {
      await authorizer.require(ctx, "workflow.read");
      return tenant(ctx, async (tx) => {
        await loadWorkflow(tx, ctx, id);
        const rows = await tx
          .select({ version: wiWorkflowVersions.version, changeNote: wiWorkflowVersions.changeNote, createdBy: wiWorkflowVersions.createdBy, createdAt: wiWorkflowVersions.createdAt, stepCount: sql<number>`coalesce(jsonb_array_length(${wiWorkflowVersions.snapshot}->'steps'), 0)::int` })
          .from(wiWorkflowVersions)
          .where(and(eq(wiWorkflowVersions.organizationId, org(ctx)), eq(wiWorkflowVersions.workflowId, id)))
          .orderBy(desc(wiWorkflowVersions.version));
        return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
      });
    },

    async getVersion(ctx, id, version) {
      await authorizer.require(ctx, "workflow.read");
      return tenant(ctx, async (tx) => {
        await loadWorkflow(tx, ctx, id);
        const [v] = await tx.select().from(wiWorkflowVersions).where(and(eq(wiWorkflowVersions.organizationId, org(ctx)), eq(wiWorkflowVersions.workflowId, id), eq(wiWorkflowVersions.version, version))).limit(1);
        if (!v) throw notFound("Workflow version", String(version));
        return { version: v.version, snapshot: v.snapshot, changeNote: v.changeNote, createdAt: v.createdAt.toISOString() };
      });
    },

    async setMetrics(ctx, id, raw) {
      await authorizer.require(ctx, "workflow.update", { type: "workflow", id });
      const input = parse(metricsInputSchema, raw);
      await tenant(ctx, async (tx) => {
        await loadWorkflow(tx, ctx, id);
        const [before] = await tx.select().from(wiWorkflowMetrics).where(and(eq(wiWorkflowMetrics.organizationId, org(ctx)), eq(wiWorkflowMetrics.workflowId, id))).limit(1);
        const values = { employeesInvolved: input.employeesInvolved ?? null, factors: input.factors, updatedBy: userId(ctx), updatedAt: new Date() };
        await tx.insert(wiWorkflowMetrics).values({ workflowId: id, organizationId: org(ctx), ...values }).onConflictDoUpdate({ target: wiWorkflowMetrics.workflowId, set: values });
        await record(ctx, "workflow.metrics_updated", "workflow", id, { before: before ? { employeesInvolved: before.employeesInvolved, factors: before.factors } : undefined, after: { employeesInvolved: values.employeesInvolved, factors: values.factors } });
      });
    },

    async setAssumptions(ctx, id, raw) {
      await authorizer.require(ctx, "workflow.roi.manage", { type: "workflow", id });
      const input = parse(assumptionsInputSchema, raw);
      await tenant(ctx, async (tx) => {
        await loadWorkflow(tx, ctx, id);
        const before = await tx.select().from(wiWorkflowAssumptions).where(and(eq(wiWorkflowAssumptions.organizationId, org(ctx)), eq(wiWorkflowAssumptions.workflowId, id)));
        for (const a of input) {
          const values = { value: a.value, provenance: a.provenance, rationale: a.rationale, updatedBy: userId(ctx), updatedAt: new Date() };
          await tx.insert(wiWorkflowAssumptions).values({ organizationId: org(ctx), workflowId: id, key: a.key, ...values }).onConflictDoUpdate({ target: [wiWorkflowAssumptions.workflowId, wiWorkflowAssumptions.key], set: values });
        }
        await record(ctx, "workflow.assumptions_updated", "workflow", id, {
          before: Object.fromEntries(before.map((b) => [b.key, { value: Number(b.value), provenance: b.provenance }])),
          after: Object.fromEntries(input.map((a) => [a.key, { value: a.value, provenance: a.provenance }])),
        });
      });
    },

    async setCosts(ctx, id, raw) {
      await authorizer.require(ctx, "workflow.roi.manage", { type: "workflow", id });
      const input = parse(costsInputSchema, raw);
      await tenant(ctx, async (tx) => {
        await loadWorkflow(tx, ctx, id);
        const before = await tx.select().from(wiWorkflowCosts).where(and(eq(wiWorkflowCosts.organizationId, org(ctx)), eq(wiWorkflowCosts.workflowId, id)));
        await tx.delete(wiWorkflowCosts).where(and(eq(wiWorkflowCosts.organizationId, org(ctx)), eq(wiWorkflowCosts.workflowId, id)));
        if (input.length) await tx.insert(wiWorkflowCosts).values(input.map((c) => ({ ...c, organizationId: org(ctx), workflowId: id })));
        await record(ctx, "workflow.costs_updated", "workflow", id, { before: before.map(({ category, period, amount, provenance }) => ({ category, period, amount: Number(amount), provenance })), after: input });
      });
    },

    async importCsv(ctx, csv, opts = {}) {
      await authorizer.require(ctx, "workflow.create");
      if (csv.length > 2_000_000) throw new AppError("VALIDATION_FAILED", "CSV is larger than 2 MB.");
      let mapped: ReturnType<typeof mapCsv>;
      try {
        mapped = mapCsv(csv);
      } catch (err) {
        throw new AppError("VALIDATION_FAILED", err instanceof Error ? err.message : "Invalid CSV.");
      }
      if (mapped.rows.length > 1000) throw new AppError("VALIDATION_FAILED", "A CSV import is limited to 1,000 rows.");
      const dataClass = opts.dataClass ?? "production";
      const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [], dataClass };
      if (mapped.unknownHeaders.length) result.errors.push({ message: `Ignored unknown column(s): ${mapped.unknownHeaders.join(", ")}` });
      await tenant(ctx, async (tx) => {
        for (const row of mapped.rows) {
          const v = row.values;
          const parsed = importRecordSchema.safeParse({
            externalId: v.sourceRef, name: v.name, description: v.description, department: v.department, ownerName: v.ownerName, businessSponsor: v.businessSponsor,
            frequency: v.frequency?.toLowerCase().replace(/[\s-]+/g, "_"), annualVolume: v.annualVolume?.replace(/[,\s]/g, ""), systems: v.systems ? splitList(v.systems) : undefined,
            roles: v.roles ? splitList(v.roles) : undefined, riskCategory: v.riskCategory?.toLowerCase(), regulatoryCategory: v.regulatoryCategory,
          });
          if (!parsed.success) {
            result.errors.push({ line: row.line, message: parsed.error.issues.map((i) => `${i.path.join(".") || "row"}: ${i.message}`).join("; ") });
            continue;
          }
          result[await upsertImported(tx, ctx, parsed.data, "csv", dataClass, null)]++;
        }
        await record(ctx, "workflow.imported", "workflow_import", "csv", { metadata: { created: result.created, updated: result.updated, skipped: result.skipped, errors: result.errors.length, dataClass } });
      });
      return result;
    },

    async importRecords(ctx, records, opts = {}) {
      await authorizer.require(ctx, "workflow.create");
      if (!Array.isArray(records) || records.length > 1000) throw new AppError("VALIDATION_FAILED", "Provide 1–1,000 records.");
      const dataClass = opts.dataClass ?? "production";
      const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [], dataClass };
      await tenant(ctx, async (tx) => {
        for (const [index, raw] of records.entries()) {
          const parsed = importRecordSchema.safeParse(raw);
          if (!parsed.success) {
            result.errors.push({ index, message: parsed.error.issues.map((i) => `${i.path.join(".") || "record"}: ${i.message}`).join("; ") });
            continue;
          }
          result[await upsertImported(tx, ctx, parsed.data, "api", dataClass, null)]++;
        }
        await record(ctx, "workflow.imported", "workflow_import", "api", { metadata: { created: result.created, updated: result.updated, skipped: result.skipped, errors: result.errors.length, dataClass } });
      });
      return result;
    },

    async importFromConnector(ctx, raw) {
      await authorizer.require(ctx, "workflow.create");
      const input = parse(connectorImportSchema, raw);
      const connector = await connectors.get(ctx, input.connectorId);
      // The shared connector framework enforces connector.use, capability scope, rate limits, retries, audit and usage.
      const response = (await connectors.execute(ctx, input.connectorId, { capability: input.capability, operation: "list", params: input.params }, { moduleId: MODULE_ID })) as Record<string, unknown> | unknown[];
      const body = (Array.isArray(response) ? { records: response } : (response ?? {})) as Record<string, unknown>;
      const items = [body.records, body.items, body.data, body.results].find(Array.isArray) as unknown[] | undefined;
      if (!items) throw new AppError("UPSTREAM_ERROR", "The connector response did not contain a list of records (expected records, items, data or results).");
      // Simulated connectors produce sample data; it must never mix with production data.
      const simulated = body.simulated === true || connector.type === "sandbox";
      const dataClass: DataClass = simulated ? "sample" : "production";
      const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [], dataClass };
      await tenant(ctx, async (tx) => {
        for (const [index, item] of items.slice(0, 1000).entries()) {
          const r = (item ?? {}) as Record<string, unknown>;
          const name = r[input.nameField] ?? r.title;
          const ext = r[input.idField];
          const parsed = importRecordSchema.safeParse({
            externalId: ext == null ? undefined : String(ext), name: typeof name === "string" ? name : undefined,
            description: typeof r.description === "string" ? r.description : undefined, department: typeof r.department === "string" ? r.department : undefined,
          });
          if (!parsed.success || !parsed.data.externalId) {
            result.errors.push({ index, message: parsed.success ? `Record has no "${input.idField}" field` : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
            continue;
          }
          result[await upsertImported(tx, ctx, parsed.data, "connector", dataClass, input.connectorId)]++;
        }
        if (items.length > 1000) result.errors.push({ message: `Only the first 1,000 of ${items.length} records were imported.` });
        await record(ctx, "workflow.imported", "workflow_import", input.connectorId, { metadata: { capability: input.capability, created: result.created, updated: result.updated, skipped: result.skipped, errors: result.errors.length, dataClass, simulated } });
      });
      return { ...result, simulated };
    },

    async loadSampleData(ctx) {
      await authorizer.require(ctx, "workflow.create");
      const { SAMPLE_WORKFLOWS } = await import("./sample-data");
      let created = 0;
      await tenant(ctx, async (tx) => {
        for (const s of SAMPLE_WORKFLOWS) {
          const [exists] = await tx.select({ id: wiWorkflows.id }).from(wiWorkflows).where(and(eq(wiWorkflows.organizationId, org(ctx)), eq(wiWorkflows.dataClass, "sample"), eq(wiWorkflows.name, s.workflow.name))).limit(1);
          if (exists) continue;
          const w = await insertWorkflow(tx, ctx, parse(workflowInputSchema, { ...s.workflow, dataClass: "sample" }), { source: "manual", sourceRef: `sample:${s.key}` });
          await tx.insert(wiWorkflowSteps).values(s.steps.map((st, i) => ({ ...parse(stepInputSchema, st), organizationId: org(ctx), workflowId: w.id, sort: i })));
          await tx.insert(wiWorkflowEdges).values(s.edges.map((e) => ({ organizationId: org(ctx), workflowId: w.id, fromKey: e.from, toKey: e.to, label: e.label ?? null })));
          await tx.insert(wiWorkflowMetrics).values({ workflowId: w.id, organizationId: org(ctx), employeesInvolved: s.employeesInvolved, factors: s.factors, updatedBy: userId(ctx) });
          await tx.insert(wiWorkflowCosts).values(s.costs.map((c) => ({ ...c, organizationId: org(ctx), workflowId: w.id })));
          await newVersion(tx, ctx, w.id, "Sample model loaded");
          created++;
        }
      });
      return { created };
    },

    async clearSampleData(ctx) {
      await authorizer.require(ctx, "workflow.delete");
      return tenant(ctx, async (tx) => {
        const rows = await tx.delete(wiWorkflows).where(and(eq(wiWorkflows.organizationId, org(ctx)), eq(wiWorkflows.dataClass, "sample"))).returning({ id: wiWorkflows.id });
        await record(ctx, "workflow.sample_data_cleared", "workflow_import", "sample", { metadata: { deleted: rows.length } });
        return { deleted: rows.length };
      });
    },

    async analyze(ctx, id) {
      await authorizer.require(ctx, "workflow.analyze", { type: "workflow", id });
      const fin = await requireFin(ctx);
      const out = await tenant(ctx, async (tx) => {
        const w = await loadWorkflow(tx, ctx, id);
        const m = await loadModel(tx, ctx, w);
        const roi = computeRoi(w, m);
        const s = computeScores(w, m, roi);
        const [scoreRow] = await tx.insert(wiWorkflowScores).values({ organizationId: org(ctx), workflowId: id, workflowVersion: w.currentVersion, modelVersion: s.modelVersion, scores: s as unknown as Record<string, unknown>, computedBy: userId(ctx) }).returning();
        await tx.insert(wiWorkflowRoiCalculations).values({ organizationId: org(ctx), workflowId: id, kind: "projected", inputs: { workflowVersion: w.currentVersion, inputs: roi.inputs, stepBreakdown: roi.stepBreakdown, warnings: roi.warnings }, outputs: roi.outputs as unknown as Record<string, unknown>, createdBy: userId(ctx) });
        const o = roi.outputs;
        const oppValues = {
          valueScore: s.position.value, complexityScore: s.position.complexity, riskScore: s.position.risk, quadrant: s.position.quadrant,
          estimatedAnnualSavings: o.annualSavings.value ?? 0, potentialRevenue: o.annualRevenue.value ?? 0, implementationCost: o.implementationCost.value ?? 0,
          paybackMonths: o.paybackMonths.value, roi3yrPct: o.roi3yrPct.value, laborHoursRecoverable: Math.max(0, o.laborHoursRecoverable.value ?? 0), updatedAt: new Date(),
        };
        const [existing] = await tx.select().from(wiWorkflowOpportunities).where(and(eq(wiWorkflowOpportunities.organizationId, org(ctx)), eq(wiWorkflowOpportunities.workflowId, id))).limit(1);
        let opp: OpportunityRow;
        if (existing) {
          [opp] = (await tx.update(wiWorkflowOpportunities).set(oppValues).where(eq(wiWorkflowOpportunities.id, existing.id)).returning()) as [OpportunityRow];
        } else {
          [opp] = (await tx.insert(wiWorkflowOpportunities).values({ organizationId: org(ctx), workflowId: id, ...oppValues, createdBy: userId(ctx) }).returning()) as [OpportunityRow];
          await record(ctx, "workflow.opportunity_created", "workflow_opportunity", opp.id, { after: { workflowId: id, quadrant: opp.quadrant, valueScore: oppValues.valueScore } });
          await bus.publish(ctx, "workflow.opportunity.created", { opportunityId: opp.id, workflowId: id, valueScore: oppValues.valueScore, quadrant: oppValues.quadrant, dataClass: w.dataClass });
          if (w.dataClass === "production" && (opp.quadrant === "quick_win" || opp.quadrant === "strategic_bet")) {
            await notifications.notify(ctx, { type: "workflow.opportunity_identified", title: `AI opportunity identified: ${w.name}`, body: `Value ${oppValues.valueScore}/100 · ${opp.quadrant.replace("_", " ")}. Review and decide.`, actionUrl: `${BASE}/opportunities?focus=${opp.id}`, recipients: { permission: "workflow.approve" } });
          }
        }
        await record(ctx, "workflow.analyzed", "workflow", id, { metadata: { version: w.currentVersion, scoreModel: s.modelVersion, roiModel: roi.modelVersion, scores: Object.fromEntries(Object.entries(s.scores).map(([k, v]) => [k, v.value])) } });
        await bus.publish(ctx, "workflow.analyzed", {
          workflowId: id, version: w.currentVersion, modelVersion: s.modelVersion, quadrant: s.position.quadrant, aiReady: s.aiReady, dataClass: w.dataClass,
          scores: { aiOpportunity: s.scores.aiOpportunity.value, automationReadiness: s.scores.automationReadiness.value, dataReadiness: s.scores.dataReadiness.value, risk: s.scores.risk.value, integrationComplexity: s.scores.integrationComplexity.value, expectedRoi: s.scores.expectedRoi.value },
        });
        const [impl] = await tx.select({ id: wiWorkflowImplementations.id }).from(wiWorkflowImplementations).where(eq(wiWorkflowImplementations.opportunityId, opp.id)).limit(1);
        return { scores: storedScores(scoreRow!, w), roi, opportunity: opportunityView(opp, w, fin, impl?.id ?? null) };
      });
      if (!fin) return { ...out, roi: { ...out.roi, inputs: [], stepBreakdown: [], outputs: Object.fromEntries(Object.entries(out.roi.outputs).map(([k, v]) => [k, { ...v, value: null }])) as RoiResult["outputs"] } };
      return out;
    },

    async redesign(ctx, id) {
      await authorizer.require(ctx, "workflow.analyze", { type: "workflow", id });
      const { w, context } = await tenant(ctx, async (tx) => {
        const w = await loadWorkflow(tx, ctx, id);
        const m = await loadModel(tx, ctx, w);
        const context: RedesignContext = {
          name: w.name, description: w.description, department: w.department, riskCategory: w.riskCategory, regulatoryCategory: w.regulatoryCategory, annualVolume: Number(w.annualVolume),
          steps: m.steps.map((s) => ({ key: s.key, type: s.type, name: s.name, description: s.description, role: s.role, system: s.system, durationMinutes: Number(s.durationMinutes), waitMinutes: Number(s.waitMinutes), requiresApproval: s.requiresApproval, risk: s.risk })),
          edges: m.edges.map((e) => ({ from: e.fromKey, to: e.toKey, label: e.label })),
        };
        return { w, context };
      });
      if (context.steps.length === 0) throw new AppError("VALIDATION_FAILED", "Model the current workflow steps before requesting a redesign.");
      const sensitive = w.riskCategory === "high" || w.riskCategory === "critical" || !!w.regulatoryCategory;
      // THE shared AI layer: routing, policy, budgets, retention, usage and the ai_runs log all happen there.
      const res = await ai.execute(ctx, {
        moduleId: MODULE_ID,
        useCase: "workflow.redesign",
        system: REDESIGN_SYSTEM,
        messages: [{ role: "user", content: buildRedesignPrompt(context) }],
        responseFormat: "json",
        maxTokens: 8000,
        dataClassification: sensitive ? "confidential" : "internal",
        promptTemplate: REDESIGN_PROMPT,
        references: { workflowId: w.id, workflowVersion: w.currentVersion },
      });
      let parsedJson: unknown;
      try {
        parsedJson = extractJson(res.text);
      } catch {
        throw new AppError("UPSTREAM_ERROR", "The AI response was not valid JSON. Nothing was saved.", { aiRunId: res.runId });
      }
      if ((parsedJson as { simulated?: unknown })?.simulated === true) {
        throw new AppError("NOT_CONFIGURED", "Only the simulated AI provider answered — it cannot produce a real redesign. Configure an AI provider under Admin → AI.", { aiRunId: res.runId });
      }
      const parsed = redesignResponseSchema.safeParse(parsedJson);
      if (!parsed.success) throw new AppError("UPSTREAM_ERROR", "The AI response did not match the redesign schema. Nothing was saved.", { aiRunId: res.runId, issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`) });
      const { proposal, warnings } = guardRedesign(context, parsed.data);
      return tenant(ctx, async (tx) => {
        const [r] = await tx
          .insert(wiWorkflowRecommendations)
          .values({ organizationId: org(ctx), workflowId: id, workflowVersion: w.currentVersion, aiRunId: res.runId, promptTemplateId: REDESIGN_PROMPT.id, promptTemplateVersion: REDESIGN_PROMPT.version, proposal: proposal as unknown as Record<string, unknown>, warnings, createdBy: userId(ctx) })
          .returning();
        await record(ctx, "workflow.redesign_proposed", "workflow_recommendation", r!.id, { metadata: { workflowId: id, aiRunId: res.runId, model: res.servedModel, promptTemplate: REDESIGN_PROMPT, warnings: warnings.length, restoredControls: proposal.restoredControls } });
        return (await recommendationViews(tx, ctx, eq(wiWorkflowRecommendations.id, r!.id)))[0]!;
      });
    },

    async reviewRecommendation(ctx, id, input) {
      await authorizer.require(ctx, "workflow.approve", { type: "workflow_recommendation", id });
      if (!z.string().uuid().safeParse(id).success) throw notFound("Recommendation", id);
      return tenant(ctx, async (tx) => {
        const [r] = await tx.select().from(wiWorkflowRecommendations).where(and(eq(wiWorkflowRecommendations.organizationId, org(ctx)), eq(wiWorkflowRecommendations.id, id))).limit(1);
        if (!r) throw notFound("Recommendation", id);
        if (r.status !== "proposed") throw conflict("This recommendation has already been reviewed.");
        await tx.update(wiWorkflowRecommendations).set({ status: input.decision === "accept" ? "accepted" : "rejected", reviewedBy: userId(ctx), reviewedAt: new Date(), reviewNote: input.note ?? null }).where(eq(wiWorkflowRecommendations.id, id));
        await record(ctx, `workflow.redesign_${input.decision === "accept" ? "accepted" : "rejected"}`, "workflow_recommendation", id, { metadata: { workflowId: r.workflowId, aiRunId: r.aiRunId, note: input.note } });
        return (await recommendationViews(tx, ctx, eq(wiWorkflowRecommendations.id, id)))[0]!;
      });
    },

    async listOpportunities(ctx, q = {}) {
      await authorizer.require(ctx, "workflow.read");
      const fin = await requireFin(ctx);
      return tenant(ctx, async (tx) => {
        const rows = await tx
          .select({ o: wiWorkflowOpportunities, w: { name: wiWorkflows.name, department: wiWorkflows.department, dataClass: wiWorkflows.dataClass }, implementationId: wiWorkflowImplementations.id })
          .from(wiWorkflowOpportunities)
          .innerJoin(wiWorkflows, eq(wiWorkflows.id, wiWorkflowOpportunities.workflowId))
          .leftJoin(wiWorkflowImplementations, eq(wiWorkflowImplementations.opportunityId, wiWorkflowOpportunities.id))
          .where(
            and(
              eq(wiWorkflowOpportunities.organizationId, org(ctx)),
              eq(wiWorkflows.dataClass, q.dataClass ?? "production"),
              q.status ? eq(wiWorkflowOpportunities.status, q.status as OpportunityRow["status"]) : undefined,
              q.quadrant ? eq(wiWorkflowOpportunities.quadrant, q.quadrant) : undefined,
              q.department ? eq(wiWorkflows.department, q.department) : undefined,
            ),
          )
          .limit(2000);
        const views = rows.map((r) => opportunityView(r.o, r.w, fin, r.implementationId));
        const key: Record<string, (v: OpportunityView) => number> = {
          value: (v) => v.valueScore,
          savings: (v) => (fin ? (v.estimatedAnnualSavings ?? 0) : v.valueScore),
          roi: (v) => (fin ? (v.roi3yrPct ?? -Infinity) : v.valueScore),
          priority: (v) => v.strategicPriority * 1000 + v.valueScore,
          risk: (v) => -v.riskScore,
        };
        const f = key[q.sort ?? "value"] ?? key.value!;
        return views.sort((a, b) => f(b) - f(a) || b.valueScore - a.valueScore);
      });
    },

    async decideOpportunity(ctx, id, raw) {
      await authorizer.require(ctx, "workflow.approve", { type: "workflow_opportunity", id });
      const input = parse(decisionSchema, raw);
      if (!z.string().uuid().safeParse(id).success) throw notFound("Opportunity", id);
      const fin = await requireFin(ctx);
      return tenant(ctx, async (tx) => {
        const [row] = await tx.select({ o: wiWorkflowOpportunities, w: wiWorkflows }).from(wiWorkflowOpportunities).innerJoin(wiWorkflows, eq(wiWorkflows.id, wiWorkflowOpportunities.workflowId)).where(and(eq(wiWorkflowOpportunities.organizationId, org(ctx)), eq(wiWorkflowOpportunities.id, id))).limit(1);
        if (!row) throw notFound("Opportunity", id);
        const { o, w } = row;
        if (o.status !== "identified" && o.status !== "rejected") throw conflict(`An opportunity in status "${o.status}" cannot be decided again.`);
        // Separation of duties: whoever produced the analysis cannot approve it.
        if (input.decision === "approve" && o.createdBy && o.createdBy === userId(ctx)) {
          await audit.recordDetached(ctx, { module: MODULE_ID, action: "workflow.opportunity_decided", resourceType: "workflow_opportunity", resourceId: id, outcome: "denied", metadata: { reason: "separation_of_duties" } });
          throw forbidden("Separation of duties: the person who analyzed this workflow cannot approve its opportunity.");
        }
        const status = input.decision === "approve" ? "approved" : "rejected";
        const [u] = await tx
          .update(wiWorkflowOpportunities)
          .set({ status, decidedBy: userId(ctx), decidedAt: new Date(), decisionNote: input.note ?? null, ...(input.strategicPriority ? { strategicPriority: input.strategicPriority } : {}), updatedAt: new Date() })
          .where(eq(wiWorkflowOpportunities.id, id))
          .returning();
        await record(ctx, "workflow.opportunity_decided", "workflow_opportunity", id, { before: { status: o.status }, after: { status, note: input.note, strategicPriority: u!.strategicPriority } });
        if (status === "approved") await bus.publish(ctx, "workflow.approved", { opportunityId: id, workflowId: w.id, decidedBy: userId(ctx) ?? ctx.actor.id, dataClass: w.dataClass });
        if (o.createdBy && o.createdBy !== userId(ctx)) {
          await notifications.notify(ctx, { type: "workflow.opportunity_decided", title: `Opportunity ${status}: ${w.name}`, body: input.note ?? undefined, actionUrl: `${BASE}/opportunities?focus=${id}`, recipients: { userIds: [o.createdBy] } });
        }
        return opportunityView(u!, w, fin, null);
      });
    },

    async startImplementation(ctx, opportunityId, raw) {
      await authorizer.require(ctx, "workflow.implementation.manage", { type: "workflow_opportunity", id: opportunityId });
      const input = parse(implementationInputSchema, raw);
      if (!z.string().uuid().safeParse(opportunityId).success) throw notFound("Opportunity", opportunityId);
      const fin = await requireFin(ctx);
      return tenant(ctx, async (tx) => {
        const [row] = await tx.select({ o: wiWorkflowOpportunities, w: wiWorkflows }).from(wiWorkflowOpportunities).innerJoin(wiWorkflows, eq(wiWorkflows.id, wiWorkflowOpportunities.workflowId)).where(and(eq(wiWorkflowOpportunities.organizationId, org(ctx)), eq(wiWorkflowOpportunities.id, opportunityId))).limit(1);
        if (!row) throw notFound("Opportunity", opportunityId);
        const { o, w } = row;
        if (o.status !== "identified" && o.status !== "approved") throw conflict(`Cannot start an implementation for an opportunity in status "${o.status}".`);
        const [dup] = await tx.select({ id: wiWorkflowImplementations.id }).from(wiWorkflowImplementations).where(eq(wiWorkflowImplementations.opportunityId, opportunityId)).limit(1);
        if (dup) throw conflict("This opportunity already has an implementation.");
        const stage: ImplementationStage = o.status === "approved" ? "approved" : "proposed";
        const [impl] = await tx
          .insert(wiWorkflowImplementations)
          .values({ organizationId: org(ctx), opportunityId, workflowId: w.id, stage, sponsor: input.sponsor ?? w.businessSponsor, owner: input.owner ?? w.ownerName, team: input.team, milestones: input.milestones, dependencies: input.dependencies, systems: input.systems.length ? input.systems : w.systems, expectedAnnualSavings: Number(o.estimatedAnnualSavings), actualCost: input.actualCost ?? 0, deploymentDate: input.deploymentDate ?? null, createdBy: userId(ctx) })
          .returning();
        if (o.status === "approved") await tx.update(wiWorkflowOpportunities).set({ status: "in_implementation", updatedAt: new Date() }).where(eq(wiWorkflowOpportunities.id, opportunityId));
        await record(ctx, "workflow.implementation_started", "workflow_implementation", impl!.id, { after: { opportunityId, stage } });
        await bus.publish(ctx, "workflow.implementation.started", { implementationId: impl!.id, opportunityId, workflowId: w.id, stage, dataClass: w.dataClass });
        return implementationView(impl!, w, fin);
      });
    },

    async listImplementations(ctx, q = {}) {
      await authorizer.require(ctx, "workflow.read");
      const fin = await requireFin(ctx);
      return tenant(ctx, async (tx) => {
        const rows = await tx
          .select({ i: wiWorkflowImplementations, w: wiWorkflows })
          .from(wiWorkflowImplementations)
          .innerJoin(wiWorkflows, eq(wiWorkflows.id, wiWorkflowImplementations.workflowId))
          .where(and(eq(wiWorkflowImplementations.organizationId, org(ctx)), eq(wiWorkflows.dataClass, q.dataClass ?? "production"), q.stage ? eq(wiWorkflowImplementations.stage, q.stage as ImplementationStage) : undefined))
          .orderBy(desc(wiWorkflowImplementations.updatedAt))
          .limit(1000);
        return rows.map((r) => implementationView(r.i, r.w, fin));
      });
    },

    async getImplementation(ctx, id) {
      await authorizer.require(ctx, "workflow.read");
      const fin = await requireFin(ctx);
      return tenant(ctx, async (tx) => {
        const { i, w } = await loadImplementation(tx, ctx, id);
        const r = await realizedFor(tx, ctx, i);
        return {
          ...implementationView(i, w, fin),
          baseline: r.baseline ? { periodDays: r.baseline.metrics.period_days ?? 0, metrics: Object.fromEntries(Object.entries(r.baseline.metrics).filter(([k]) => k !== "period_days")), provenance: r.baseline.provenance, capturedAt: r.baseline.capturedAt.toISOString() } : null,
          measurements: r.measurements.map((m) => ({ id: m.id, periodStart: m.periodStart, periodEnd: m.periodEnd, metrics: m.metrics, provenance: m.provenance, note: m.note, createdAt: m.createdAt.toISOString() })),
          realized: fin ? r.realized : null,
          projected: fin ? r.projected : null,
        };
      });
    },

    async updateImplementation(ctx, id, raw) {
      await authorizer.require(ctx, "workflow.implementation.manage", { type: "workflow_implementation", id });
      const input = parse(implementationInputSchema.partial(), raw);
      const fin = await requireFin(ctx);
      return tenant(ctx, async (tx) => {
        const { i, w } = await loadImplementation(tx, ctx, id);
        if (input.actualCost !== undefined) await authorizer.require(ctx, "workflow.roi.manage");
        const [u] = await tx.update(wiWorkflowImplementations).set({ ...input, updatedAt: new Date() }).where(eq(wiWorkflowImplementations.id, id)).returning();
        await record(ctx, "workflow.implementation_updated", "workflow_implementation", id, { before: implementationView(i, w, true), after: implementationView(u!, w, true) });
        return implementationView(u!, w, fin);
      });
    },

    async advanceStage(ctx, id, stage, note) {
      await authorizer.require(ctx, "workflow.implementation.manage", { type: "workflow_implementation", id });
      if (!(IMPLEMENTATION_STAGES as readonly string[]).includes(stage)) throw new AppError("VALIDATION_FAILED", `Unknown stage "${stage}".`);
      const fin = await requireFin(ctx);
      return tenant(ctx, async (tx) => {
        const { i, w } = await loadImplementation(tx, ctx, id);
        const from = STAGE_INDEX[i.stage];
        const to = STAGE_INDEX[stage];
        if (to === from) return implementationView(i, w, fin);
        if (to > from + 1) throw conflict(`Stages advance one at a time: next stage after "${i.stage}" is "${IMPLEMENTATION_STAGES[from + 1]}".`);
        const [o] = await tx.select().from(wiWorkflowOpportunities).where(eq(wiWorkflowOpportunities.id, i.opportunityId)).limit(1);
        if (to > from) {
          if (stage === "approved" && o!.status !== "approved" && o!.status !== "in_implementation") throw conflict("The opportunity must be approved (workflow.approve) before the implementation can move to Approved.");
          if (stage === "production") {
            const [b] = await tx.select({ id: wiWorkflowBaselines.id }).from(wiWorkflowBaselines).where(eq(wiWorkflowBaselines.implementationId, id)).limit(1);
            if (!b) throw conflict("Capture a pre-deployment baseline before moving to Production — realized ROI cannot be measured without one.");
          }
          if (stage === "measured") {
            const [m] = await tx.select({ id: wiWorkflowMeasurements.id }).from(wiWorkflowMeasurements).where(eq(wiWorkflowMeasurements.implementationId, id)).limit(1);
            if (!m) throw conflict("Record at least one post-deployment measurement before marking the implementation Measured.");
          }
        }
        const deploymentDate = stage === "production" ? (i.deploymentDate ?? new Date().toISOString().slice(0, 10)) : i.deploymentDate;
        const [u] = await tx.update(wiWorkflowImplementations).set({ stage, deploymentDate, updatedAt: new Date() }).where(eq(wiWorkflowImplementations.id, id)).returning();
        if (stage === "approved" && o!.status === "approved") await tx.update(wiWorkflowOpportunities).set({ status: "in_implementation", updatedAt: new Date() }).where(eq(wiWorkflowOpportunities.id, o!.id));
        if (stage === "production" && to > from) {
          await tx.update(wiWorkflowOpportunities).set({ status: "delivered", updatedAt: new Date() }).where(eq(wiWorkflowOpportunities.id, o!.id));
          await bus.publish(ctx, "workflow.production.started", { implementationId: id, workflowId: w.id, deploymentDate: deploymentDate!, dataClass: w.dataClass });
          if (w.dataClass === "production") {
            await notifications.notify(ctx, { type: "workflow.implementation_production", title: `In production: ${w.name}`, body: "Record post-deployment measurements to track realized ROI.", actionUrl: `${BASE}/implementations/${id}`, recipients: { permission: "workflow.roi.manage" } });
          }
        }
        await record(ctx, "workflow.implementation_stage_changed", "workflow_implementation", id, { before: { stage: i.stage }, after: { stage }, metadata: note ? { note } : undefined });
        return implementationView(u!, w, fin);
      });
    },

    async recordBaseline(ctx, id, raw) {
      await authorizer.require(ctx, "workflow.roi.manage", { type: "workflow_implementation", id });
      const input = parse(baselineInputSchema, raw);
      await tenant(ctx, async (tx) => {
        const { i } = await loadImplementation(tx, ctx, id);
        if (STAGE_INDEX[i.stage] >= STAGE_INDEX.production) throw conflict("Baselines describe the process before deployment and are frozen once the implementation reaches Production.");
        const [b] = await tx.insert(wiWorkflowBaselines).values({ organizationId: org(ctx), implementationId: id, workflowId: i.workflowId, metrics: { ...input.metrics, period_days: input.periodDays }, provenance: input.provenance, capturedBy: userId(ctx) }).returning();
        await record(ctx, "workflow.baseline_captured", "workflow_implementation", id, { after: { baselineId: b!.id, periodDays: input.periodDays, metrics: input.metrics, provenance: input.provenance } });
      });
    },

    async recordMeasurement(ctx, id, raw) {
      await authorizer.require(ctx, "workflow.roi.manage", { type: "workflow_implementation", id });
      const input = parse(measurementInputSchema, raw);
      return tenant(ctx, async (tx) => {
        const { i, w } = await loadImplementation(tx, ctx, id);
        if (STAGE_INDEX[i.stage] < STAGE_INDEX.pilot) throw conflict("Measurements are recorded from the Pilot stage onwards.");
        const [m] = await tx.insert(wiWorkflowMeasurements).values({ organizationId: org(ctx), implementationId: id, workflowId: i.workflowId, periodStart: input.periodStart, periodEnd: input.periodEnd, metrics: input.metrics, provenance: input.provenance, note: input.note ?? null, createdBy: userId(ctx) }).returning();
        const r = await realizedFor(tx, ctx, i);
        if (!r.baseline) throw conflict("Capture a baseline before recording measurements.");
        if (!r.projected) throw conflict("Analyze the workflow first — there is no projected ROI to compare against.");
        const realized = r.realized!;
        await tx.insert(wiWorkflowRoiCalculations).values({ organizationId: org(ctx), workflowId: i.workflowId, implementationId: id, kind: "actual", inputs: { baselineId: r.baseline.id, measurementIds: r.measurements.map((x) => x.id), actualImplementationCost: Number(i.actualCost) }, outputs: realized as unknown as Record<string, unknown>, createdBy: userId(ctx) });
        const actualSavings = realized.lines.find((l) => l.key === "annualSavings")?.actual ?? null;
        await record(ctx, "workflow.roi_measured", "workflow_implementation", id, { after: { measurementId: m!.id, periodStart: input.periodStart, periodEnd: input.periodEnd, metrics: input.metrics, provenance: input.provenance, actualAnnualSavings: actualSavings } });
        await bus.publish(ctx, "workflow.roi.measured", { implementationId: id, workflowId: w.id, measurementId: m!.id, actualAnnualSavings: actualSavings, dataClass: w.dataClass });
        return { measurementId: m!.id, realized };
      });
    },

    async dashboard(ctx, q = {}) {
      await authorizer.require(ctx, "workflow.read");
      const fin = await requireFin(ctx);
      const dataClass = q.dataClass ?? "production";
      return tenant(ctx, async (tx) => {
        const workflows = await tx.select().from(wiWorkflows).where(and(eq(wiWorkflows.organizationId, org(ctx)), eq(wiWorkflows.dataClass, dataClass)));
        const ids = workflows.map((w) => w.id);
        const scores = await latestScores(tx, ctx, ids);
        const opps = ids.length ? await tx.select().from(wiWorkflowOpportunities).where(and(eq(wiWorkflowOpportunities.organizationId, org(ctx)), inArray(wiWorkflowOpportunities.workflowId, ids))) : [];
        const impls = ids.length ? await tx.select().from(wiWorkflowImplementations).where(and(eq(wiWorkflowImplementations.organizationId, org(ctx)), inArray(wiWorkflowImplementations.workflowId, ids))) : [];
        const actuals = impls.length
          ? await tx
              .selectDistinctOn([wiWorkflowRoiCalculations.implementationId])
              .from(wiWorkflowRoiCalculations)
              .where(and(eq(wiWorkflowRoiCalculations.organizationId, org(ctx)), eq(wiWorkflowRoiCalculations.kind, "actual"), inArray(wiWorkflowRoiCalculations.workflowId, ids)))
              .orderBy(wiWorkflowRoiCalculations.implementationId, desc(wiWorkflowRoiCalculations.createdAt))
          : [];
        const actualByImpl = new Map(actuals.map((a) => [a.implementationId!, a.outputs as unknown as RealizedResult]));
        const wfById = new Map(workflows.map((w) => [w.id, w]));
        const live = opps.filter((o) => o.status !== "rejected");
        const committed = opps.filter((o) => o.status === "approved" || o.status === "in_implementation" || o.status === "delivered");
        const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((n, x) => n + f(x), 0);
        const parsedScores = [...scores.values()].map((s) => storedScores(s, wfById.get(s.workflowId)!));

        // Portfolio projected ROI over committed opportunities, from each workflow's latest projected calculation.
        const committedIds = committed.map((o) => o.workflowId);
        const projections = committedIds.length
          ? await tx
              .selectDistinctOn([wiWorkflowRoiCalculations.workflowId], { workflowId: wiWorkflowRoiCalculations.workflowId, outputs: wiWorkflowRoiCalculations.outputs })
              .from(wiWorkflowRoiCalculations)
              .where(and(eq(wiWorkflowRoiCalculations.organizationId, org(ctx)), eq(wiWorkflowRoiCalculations.kind, "projected"), inArray(wiWorkflowRoiCalculations.workflowId, committedIds)))
              .orderBy(wiWorkflowRoiCalculations.workflowId, desc(wiWorkflowRoiCalculations.createdAt))
          : [];
        const committedImpl = sum(committed, (o) => Number(o.implementationCost));
        const committedNet = sum(projections, (p) => (p.outputs as unknown as RoiResult["outputs"]).netAnnualBenefit.value ?? 0);
        const projectedRoi = committedImpl > 0 ? Math.round(((committedNet * 3 - committedImpl) / committedImpl) * 1000) / 10 : null;

        let realizedNet = 0;
        let realizedCost = 0;
        let realizedSavings = 0;
        let anyRealized = false;
        const projectedVsActual: DashboardView["projectedVsActual"] = [];
        for (const i of impls) {
          const a = actualByImpl.get(i.id);
          const line = a?.lines.find((l) => l.key === "annualSavings");
          const net = a?.lines.find((l) => l.key === "netAnnualBenefit")?.actual;
          if (a && net != null) {
            anyRealized = true;
            realizedNet += net;
            realizedCost += Number(i.actualCost);
            realizedSavings += line?.actual ?? 0;
          }
          projectedVsActual.push({ implementationId: i.id, workflowName: wfById.get(i.workflowId)?.name ?? "", stage: i.stage, projected: fin ? (line?.projected ?? Number(i.expectedAnnualSavings)) : null, actual: fin ? (line?.actual ?? null) : null });
        }
        // Realized ROI annualised over one year of benefit vs. actual spend to date.
        const realizedRoi = anyRealized && realizedCost > 0 ? Math.round(((realizedNet - realizedCost) / realizedCost) * 1000) / 10 : null;

        const bandCounts = (pick: (s: StoredScores) => number, labels: [string, string, string]) => {
          const c = [0, 0, 0];
          for (const s of parsedScores) {
            const v = pick(s);
            c[v >= 67 ? 2 : v >= 34 ? 1 : 0]!++;
          }
          return [
            { label: labels[0], value: c[0]! },
            { label: labels[1], value: c[1]! },
            { label: labels[2], value: c[2]! },
            { label: "Not analyzed", value: workflows.length - parsedScores.length },
          ];
        };
        const depts = new Map<string, { workflows: number; savings: number }>();
        for (const w of workflows) {
          const d = w.department || "Unassigned";
          const cur = depts.get(d) ?? { workflows: 0, savings: 0 };
          cur.workflows++;
          const o = live.find((x) => x.workflowId === w.id);
          cur.savings += o ? Number(o.estimatedAnnualSavings) : 0;
          depts.set(d, cur);
        }
        const quadrantCounts = new Map<string, number>();
        for (const o of opps) quadrantCounts.set(o.quadrant, (quadrantCounts.get(o.quadrant) ?? 0) + 1);

        return {
          dataClass,
          canSeeFinancials: fin,
          totals: {
            workflows: workflows.length,
            analyzed: parsedScores.length,
            highValueOpportunities: live.filter((o) => o.quadrant === "quick_win" || o.quadrant === "strategic_bet").length,
            aiReady: parsedScores.filter((s) => s.aiReady).length,
            activeImplementations: impls.filter((i) => ACTIVE_STAGES.includes(i.stage)).length,
            laborHoursRecoverable: Math.round(sum(live, (o) => Number(o.laborHoursRecoverable))),
            estimatedAnnualSavings: fin ? Math.round(sum(live, (o) => Number(o.estimatedAnnualSavings))) : null,
            potentialRevenue: fin ? Math.round(sum(live, (o) => Number(o.potentialRevenue))) : null,
            implementationInvestment: fin ? Math.round(committedImpl) : null,
            projectedRoi3yrPct: fin ? projectedRoi : null,
            realizedRoiPct: fin ? realizedRoi : null,
            realizedAnnualSavings: fin && anyRealized ? Math.round(realizedSavings) : null,
          },
          byDepartment: [...depts.entries()].sort((a, b) => b[1].workflows - a[1].workflows).map(([label, v]) => ({ label, workflows: v.workflows, savings: fin ? Math.round(v.savings) : null })),
          byReadiness: bandCounts((s) => s.scores.automationReadiness.value, ["Low readiness", "Medium readiness", "High readiness"]),
          byRisk: bandCounts((s) => s.scores.risk.value, ["Low risk", "Medium risk", "High risk"]),
          byComplexity: bandCounts((s) => s.scores.integrationComplexity.value, ["Low complexity", "Medium complexity", "High complexity"]),
          quadrants: ["quick_win", "strategic_bet", "fill_in", "deprioritize"].map((q) => ({ label: q, value: quadrantCounts.get(q) ?? 0 })),
          projectedVsActual,
          formulas: {
            highValueOpportunities: "Non-rejected opportunities in the Quick win or Strategic bet quadrant (value score ≥ 50).",
            aiReady: "Latest analysis has Automation Readiness ≥ 60, Data Readiness ≥ 60 and Risk < 67.",
            estimatedAnnualSavings: "Σ projected annual savings of non-rejected opportunities (latest analysis of each workflow).",
            laborHoursRecoverable: "Σ projected recoverable labor hours of non-rejected opportunities.",
            implementationInvestment: "Σ projected one-time implementation cost of approved, in-implementation and delivered opportunities.",
            projectedRoi3yrPct: "(Σ net annual benefit × 3 − Σ implementation cost) ÷ Σ implementation cost over committed opportunities.",
            realizedRoiPct: "(Σ measured net annual benefit − Σ actual implementation cost) ÷ Σ actual implementation cost, over implementations with measurements.",
            activeImplementations: "Implementations in Approved, Design, Build, Testing, Pilot or Production.",
          },
        };
      });
    },
  };
}

/** Search provider over the module's workflows (registered into the SHARED search service). */
export function workflowSearch(db: Database) {
  return async (ctx: TenantContext, q: string, limit: number) => {
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const rows = await db.withTenant(scopeOf(ctx), (tx) =>
      tx
        .select({ id: wiWorkflows.id, name: wiWorkflows.name, department: wiWorkflows.department, dataClass: wiWorkflows.dataClass })
        .from(wiWorkflows)
        .where(and(eq(wiWorkflows.organizationId, ctx.organizationId), or(ilike(wiWorkflows.name, like), ilike(wiWorkflows.department, like), ilike(wiWorkflows.description, like))))
        .limit(limit),
    );
    return rows.map((r) => ({ id: r.id, title: r.name, subtitle: `${r.department ?? "No department"}${r.dataClass === "sample" ? " · SAMPLE" : ""}`, url: `${BASE}/workflows/${r.id}` }));
  };
}

