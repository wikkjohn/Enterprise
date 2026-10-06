import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { type AIPolicyHook, type AIPolicyHookResult } from "@eaop/ai";
import { type AuditService } from "@eaop/audit";
import { type ConnectorService } from "@eaop/connectors";
import { and, desc, eq, gte, ilike, inArray, memberships, ne, not, or, scopeOf, sql, users, type Database, type Tx } from "@eaop/db";
import { type EventBus } from "@eaop/events";
import { type JobQueue } from "@eaop/jobs";
import { type ModuleService } from "@eaop/module-registry";
import { type NotificationService } from "@eaop/notifications";
import { type Logger } from "@eaop/observability";
import { type OrganizationService } from "@eaop/organizations";
import { type PolicyService } from "@eaop/policies";
import { type Authorizer } from "@eaop/rbac";
import { type SecretStore } from "@eaop/secrets";
import { hmacSha256 } from "@eaop/security";
import { type Actor, AppError, conflict, forbidden, isAppError, isUuid, notFound, SYSTEM_ACTOR, type TenantContext } from "@eaop/shared-types";
import { type UsageService } from "@eaop/usage";
import { analyzeAccess, inferExposure, observedExposure, SEVERITY_RANK, SHARING_SCOPES, type AssetPermissions, type Severity } from "./analysis";
import { CATEGORIES, CATEGORY_META, CONFIDENCE_RANK, detect, overallSensitivity, safePattern, SENSITIVITY_RANK, sensitivityOf, summarize, type CategorySummary, type CustomRule, type Match, type Sensitivity } from "./detect";
import { actionFor, decideDlp, DEFAULT_ACTIONS, DLP_DECISIONS, fromPolicyEffect, stricter, type CategoryAction, type DestinationTrust, type DlpDecision } from "./dlp";
import { redact, REDACTION_MODES, safePreview } from "./redact";
import {
  accessFindings, classificationRules, dataAssets, dataAssetVersions, dataClassifications, dataScans, dlpEvents, dsSettings, exposureFindings, incidentEvents, INCIDENT_KINDS,
  redactionEvents, remediationActions, securityIncidents, shadowAiTools, shadowAiUsage, type DetectionSummary, type IncidentKind, type RemediationAction,
} from "./schema";
import { AI_TOOL_CATALOG, matchCatalog, normalizeDomain, TOOL_CATEGORIES, TOOL_STATUSES, toolRisk, type ToolStatus } from "./shadow";

export const MODULE_ID = "data_security" as const;
export const SCAN_JOB = "data_security.scan";
export const RETENTION_JOB = "data_security.retention";
const BASE = "/m/data-security";
const APPROVAL_REQUEST_DAYS = 7;
const APPROVAL_VALID_HOURS = 24;

function parse<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.output<S> {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  throw new AppError("VALIDATION_FAILED", r.error.issues[0] ? `${r.error.issues[0].path.join(".") || "input"}: ${r.error.issues[0].message}` : "Request validation failed.", {
    issues: r.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })),
  });
}

// ── Input schemas ───────────────────────────────────────────────────────────

const text = (max: number) => z.string().trim().max(max);
const sensitivityEnum = z.enum(["public", "internal", "confidential", "restricted"]);
const isoDate = z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/));

const principalSchema = z.object({
  type: z.enum(["user", "group", "link", "domain"]),
  id: text(300).optional(),
  name: text(300).optional(),
  email: z.string().trim().toLowerCase().max(320).optional(),
  role: text(60).optional(),
  memberCount: z.number().int().min(0).max(100_000_000).optional(),
  inherited: z.boolean().optional(),
  lastActiveAt: isoDate.optional(),
  status: z.enum(["active", "disabled", "departed", "guest"]).optional(),
});

export const assetInputSchema = z.object({
  externalId: text(500).min(1),
  name: text(500).min(1),
  sourceSystem: text(60).min(1).optional(),
  type: text(60).default("file"),
  location: text(2000).default(""),
  owner: z.string().trim().toLowerCase().max(320).nullish(),
  department: text(120).nullish(),
  lastModifiedAt: isoDate.nullish(),
  lastAccessedAt: isoDate.nullish(),
  retentionCategory: text(120).nullish(),
  sizeBytes: z.number().int().min(0).nullish(),
  permissions: z.object({ scope: z.enum(SHARING_SCOPES).default("private"), publicLink: z.boolean().optional(), principals: z.array(principalSchema).max(500).default([]) }).default({ scope: "private", principals: [] }),
  /** Text sample to classify. Classified in memory and discarded — never stored. */
  content: z.string().max(2_000_000).optional(),
});
export type AssetInput = z.output<typeof assetInputSchema>;

export const ingestSchema = z.object({ sourceSystem: text(60).min(1), assets: z.array(assetInputSchema).min(1).max(500) });

export const ruleSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  label: text(120).min(1),
  description: text(1000).default(""),
  sensitivity: sensitivityEnum.default("confidential"),
  patterns: z.array(z.string().max(200)).max(10).default([]),
  keywords: z.array(text(100).min(2)).max(50).default([]),
  confidence: z.enum(["low", "medium", "high"]).default("medium"),
  actionApproved: z.enum(DLP_DECISIONS).optional(),
  actionUnapproved: z.enum(DLP_DECISIONS).optional(),
  minConfidence: z.enum(["low", "medium", "high"]).default("medium"),
  redactionMode: z.enum(REDACTION_MODES).default("label"),
  enabled: z.boolean().default(true),
});

export const evaluateSchema = z.object({
  content: z.string().min(1).max(2_000_000),
  /** Domain, URL, or name of the AI destination (e.g. "chatgpt.com"). */
  destination: text(300).min(1),
  assetIds: z.array(z.string().uuid()).max(50).default([]),
  /** Who the content belongs to, when an enforcement point evaluates on a user's behalf. */
  userEmail: z.string().trim().toLowerCase().email().max(320).optional(),
});

export const telemetrySchema = z.object({
  source: text(80).min(1),
  events: z.array(z.object({
    domain: text(500).optional(),
    url: text(2000).optional(),
    /** Set by the telemetry source when it knows the destination is an AI service not in the catalog. */
    ai: z.boolean().optional(),
    toolName: text(120).optional(),
    vendor: text(120).optional(),
    userEmail: z.string().trim().toLowerCase().max(320).optional(),
    userId: text(200).optional(),
    department: text(120).optional(),
    occurredAt: isoDate,
    count: z.number().int().min(1).max(1_000_000).default(1),
    bytesOut: z.number().int().min(0).optional(),
    dataCategories: z.array(text(40)).max(20).default([]),
    externalRef: text(200).optional(),
  }).refine((e) => e.domain || e.url, "domain or url is required")).min(1).max(1000),
});

export const settingsSchema = z.object({
  contentRetention: z.enum(["none", "redacted_preview"]).optional(),
  largeExportChars: z.number().int().min(1000).max(100_000_000).optional(),
  abnormalBlockedPerHour: z.number().int().min(2).max(10_000).optional(),
  broadGroupSize: z.number().int().min(10).max(10_000_000).optional(),
});

// ── Views ───────────────────────────────────────────────────────────────────

type AssetRow = typeof dataAssets.$inferSelect;
type IncidentRow = typeof securityIncidents.$inferSelect;
type ToolRow = typeof shadowAiTools.$inferSelect;
type DlpRow = typeof dlpEvents.$inferSelect;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export const assetView = (a: AssetRow, ownerName: string | null = null) => ({
  id: a.id, name: a.name, sourceSystem: a.sourceSystem, externalId: a.externalId, type: a.assetType, location: a.location, connectorId: a.connectorId,
  ownerUserId: a.ownerUserId, owner: ownerName ?? a.ownerLabel, department: a.department, classification: a.classification, classificationLocked: a.classificationLocked,
  categories: a.categories, sharingScope: a.sharingScope, permissions: a.permissions, lastModifiedAt: iso(a.lastModifiedAt), lastAccessedAt: iso(a.lastAccessedAt),
  retentionCategory: a.retentionCategory, aiExposureStatus: a.aiExposureStatus, sizeBytes: a.sizeBytes, discoveredVia: a.discoveredVia, currentVersion: a.currentVersion,
  lastClassifiedAt: iso(a.lastClassifiedAt), createdAt: a.createdAt.toISOString(), updatedAt: a.updatedAt.toISOString(),
});
export type AssetView = ReturnType<typeof assetView>;

export const toolView = (t: ToolRow) => ({
  id: t.id, vendor: t.vendor, name: t.name, category: t.category, domains: t.domains, status: t.status, source: t.source, userCount: t.userCount, departments: t.departments,
  dataCategories: t.dataCategories, riskScore: t.riskScore, riskLevel: t.riskLevel, riskFactors: t.riskFactors, notes: t.notes, firstSeenAt: t.firstSeenAt.toISOString(), lastSeenAt: t.lastSeenAt.toISOString(),
});
export type ToolView = ReturnType<typeof toolView>;

export const dlpView = (e: DlpRow) => ({
  id: e.id, source: e.source, actor: { type: e.actorType, id: e.actorId, label: e.actorLabel }, destination: e.destination, destinationTrust: e.destinationTrust, destinationCategory: e.destinationCategory,
  toolId: e.toolId, moduleId: e.moduleId, useCase: e.useCase, decision: e.decision, reasons: e.reasons, detections: e.detections, categories: e.categories, policies: e.policies,
  contentChars: e.contentChars, redactedPreview: e.redactedPreview, assetIds: e.assetIds, approvalStatus: e.approvalStatus, approvalNote: e.approvalNote,
  approvalDecidedAt: iso(e.approvalDecidedAt), approvalExpiresAt: iso(e.approvalExpiresAt), approvedVia: e.approvedVia, incidentId: e.incidentId, createdAt: e.createdAt.toISOString(),
});
export type DlpEventView = ReturnType<typeof dlpView>;

export const incidentView = (i: IncidentRow, ownerName: string | null = null) => ({
  id: i.id, kind: i.kind, severity: i.severity, status: i.status, title: i.title, description: i.description, source: i.source, ownerUserId: i.ownerUserId, ownerName,
  affectedAssetIds: i.affectedAssetIds, affectedUsers: i.affectedUsers, rootCause: i.rootCause, resolution: i.resolution, remediation: i.remediation, eventCount: i.eventCount,
  resolvedAt: iso(i.resolvedAt), createdAt: i.createdAt.toISOString(), updatedAt: i.updatedAt.toISOString(),
});
export type IncidentView = ReturnType<typeof incidentView>;

export const remediationView = (r: typeof remediationActions.$inferSelect) => ({
  id: r.id, action: r.action, execution: r.execution, status: r.status, assetId: r.assetId, toolId: r.toolId, incidentId: r.incidentId, findingType: r.findingType, findingId: r.findingId,
  title: r.title, detail: r.detail, params: r.params, result: r.result, completedAt: iso(r.completedAt), createdAt: r.createdAt.toISOString(),
});
export type RemediationView = ReturnType<typeof remediationView>;

export interface DashboardView {
  sensitiveAssets: number;
  exposedSensitiveAssets: number;
  totalAssets: number;
  shadowAiTools: number;
  unapprovedAiTools: number;
  blockedTransmissions30d: number;
  redactedTransmissions30d: number;
  pendingApprovals: number;
  openIncidents: number;
  criticalIncidents: number;
  permissionRisks: Record<Severity, number>;
  remediation: { completed: number; open: number; dismissed: number; percent: number };
  telemetryConnected: boolean;
  lastScanAt: string | null;
  byCategory: Array<{ label: string; value: number }>;
  dlp30d: Array<{ label: string; value: number }>;
  topFindings: Array<{ id: string; assetId: string; assetName: string; kind: string; severity: string; detail: string }>;
}

export interface DataSecurityDeps {
  db: Database;
  authorizer: Authorizer;
  audit: AuditService;
  bus: EventBus;
  notifications: NotificationService;
  policies: PolicyService;
  connectors: ConnectorService;
  secrets: SecretStore;
  jobs: JobQueue;
  organizations: OrganizationService;
  usage: UsageService;
  modules: Pick<ModuleService, "requireEnabled" | "isEnabled">;
  logger: Logger;
}

export type DataSecurityService = ReturnType<typeof createDataSecurityService>;

interface Destination { name: string; trust: DestinationTrust; category: string; toolId: string | null }

export function createDataSecurityService(deps: DataSecurityDeps) {
  const { db, authorizer, audit, bus, notifications, policies, connectors, secrets, jobs, organizations, usage, modules, logger } = deps;
  const tenant = <T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>) => db.withTenant(scopeOf(ctx), fn);
  const orgScope = <T>(orgId: string, fn: (tx: Tx) => Promise<T>) => db.withTenant({ organizationId: orgId }, fn);
  const org = (ctx: TenantContext) => ctx.organizationId;
  const userId = (ctx: TenantContext) => (ctx.actor.type === "user" ? ctx.actor.id : null);
  const record = (ctx: TenantContext, action: string, resourceType: string, resourceId: string, extra: { before?: unknown; after?: unknown; metadata?: Record<string, unknown>; outcome?: "success" | "failure" | "denied" } = {}) =>
    audit.record(ctx, { module: MODULE_ID, action, resourceType, resourceId, ...extra });
  const sysCtx = (orgId: string, correlationId = randomUUID()): TenantContext => ({ organizationId: orgId, actor: SYSTEM_ACTOR("data_security"), correlationId, cache: new Map() });
  const uuidOr404 = (id: string, what: string) => {
    if (!isUuid(id)) throw notFound(what, id);
  };

  // ── Settings, keys, rules ───────────────────────────────────────────────
  async function settings(orgId: string) {
    return orgScope(orgId, async (tx) => {
      const [s] = await tx.select().from(dsSettings).where(eq(dsSettings.organizationId, orgId)).limit(1);
      if (s) return s;
      const [c] = await tx.insert(dsSettings).values({ organizationId: orgId }).onConflictDoNothing().returning();
      return c ?? (await tx.select().from(dsSettings).where(eq(dsSettings.organizationId, orgId)).limit(1))[0]!;
    });
  }

  const keyCache = new Map<string, { key: string; at: number }>();
  /** Per-organization HMAC key (shared secret store) for tokenization and fingerprints. */
  async function orgKey(orgId: string): Promise<string> {
    const c = keyCache.get(orgId);
    if (c && Date.now() - c.at < 300_000) return c.key;
    const s = await settings(orgId);
    let key: string;
    if (s.tokenizationSecretRef) key = await secrets.get(s.tokenizationSecretRef, orgId);
    else {
      key = randomBytes(32).toString("hex");
      const ref = await secrets.put({ organizationId: orgId, name: "data_security/tokenization_key", value: key });
      const [won] = await orgScope(orgId, (tx) => tx.update(dsSettings).set({ tokenizationSecretRef: ref }).where(and(eq(dsSettings.organizationId, orgId), sql`${dsSettings.tokenizationSecretRef} is null`)).returning());
      if (!won) {
        await secrets.destroy(ref, orgId).catch(() => undefined); // lost a race: use the winner's key
        const again = await settings(orgId);
        key = await secrets.get(again.tokenizationSecretRef!, orgId);
      }
    }
    keyCache.set(orgId, { key, at: Date.now() });
    return key;
  }
  const fingerprint = async (orgId: string, value: string) => hmacSha256(await orgKey(orgId), value);

  async function loadRules(orgId: string): Promise<{ custom: CustomRule[]; actions: CategoryAction[]; labels: Record<string, string> }> {
    const rows = await orgScope(orgId, (tx) => tx.select().from(classificationRules).where(and(eq(classificationRules.organizationId, orgId), eq(classificationRules.enabled, true))));
    return {
      custom: rows.filter((r) => !r.builtin).map((r) => ({ key: r.key, label: r.label, sensitivity: r.sensitivity, patterns: r.patterns, keywords: r.keywords, confidence: r.confidence })),
      actions: rows.map((r) => ({ category: r.key, approved: r.actionApproved, unapproved: r.actionUnapproved, minConfidence: r.minConfidence, redactionMode: r.redactionMode })),
      labels: Object.fromEntries(rows.map((r) => [r.key, r.label])),
    };
  }

  async function inactiveEmails(orgId: string): Promise<Set<string>> {
    const rows = await orgScope(orgId, (tx) =>
      tx.select({ email: users.email }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(and(eq(memberships.organizationId, orgId), or(inArray(memberships.status, ["suspended", "removed"]), inArray(users.status, ["suspended", "deactivated"])))),
    );
    return new Set(rows.map((r) => r.email.toLowerCase()));
  }
  async function memberByEmail(tx: Tx, orgId: string, email: string | null | undefined) {
    if (!email) return null;
    const [u] = await tx.select({ id: users.id, name: users.name }).from(users).innerJoin(memberships, eq(memberships.userId, users.id)).where(and(eq(memberships.organizationId, orgId), eq(memberships.status, "active"), sql`lower(${users.email}) = ${email.toLowerCase()}`)).limit(1);
    return u ?? null;
  }

  // ── Remediation recommendations ─────────────────────────────────────────
  const AUTOMATIC: RemediationAction[] = ["change_classification", "assign_owner", "block_ai_destination", "require_approval"];
  async function recommend(tx: Tx, orgId: string, r: { action: RemediationAction; title: string; detail: string; dedupeKey: string; assetId?: string | null; toolId?: string | null; incidentId?: string | null; findingType?: "access" | "exposure" | "incident" | "classification"; findingId?: string | null; params?: Record<string, unknown> }) {
    await tx.insert(remediationActions).values({
      organizationId: orgId, action: r.action, execution: AUTOMATIC.includes(r.action) ? "automatic" : "manual", assetId: r.assetId ?? null, toolId: r.toolId ?? null, incidentId: r.incidentId ?? null,
      findingType: r.findingType ?? null, findingId: r.findingId ?? null, title: r.title, detail: r.detail, params: r.params ?? {}, dedupeKey: r.dedupeKey,
    }).onConflictDoNothing();
  }

  // ── Assets: classify + analyze (one asset, one transaction) ─────────────
  async function upsertAsset(orgId: string, input: AssetInput & { sourceSystem: string }, src: { via: "connector" | "api" | "manual"; connectorId?: string | null; scanId?: string | null; actor: TenantContext }) {
    const rules = await loadRules(orgId);
    const st = await settings(orgId);
    const inactive = await inactiveEmails(orgId);
    const classify = input.content !== undefined;
    const matches = classify ? detect(input.content!, { customRules: rules.custom, hint: input.name }) : [];
    const summaries = summarize(matches);
    const contentFp = classify ? await fingerprint(orgId, input.content!) : null;
    const now = new Date();

    const res = await orgScope(orgId, async (tx) => {
      const [existing] = await tx.select().from(dataAssets).where(and(eq(dataAssets.organizationId, orgId), eq(dataAssets.sourceSystem, input.sourceSystem), eq(dataAssets.externalId, input.externalId))).limit(1);
      const owner = await memberByEmail(tx, orgId, input.owner);
      const perms: AssetPermissions = { scope: input.permissions.scope, publicLink: input.permissions.publicLink, principals: input.permissions.principals };
      const base = {
        organizationId: orgId, connectorId: src.connectorId ?? existing?.connectorId ?? null, sourceSystem: input.sourceSystem, externalId: input.externalId, name: input.name, assetType: input.type,
        location: input.location, ownerUserId: owner?.id ?? null, ownerLabel: owner ? null : (input.owner ?? null), department: input.department ?? null, permissions: perms as unknown as Record<string, unknown>,
        sharingScope: perms.publicLink && perms.scope !== "public" ? ("public" as const) : perms.scope, lastModifiedAt: input.lastModifiedAt ? new Date(input.lastModifiedAt) : null,
        lastAccessedAt: input.lastAccessedAt ? new Date(input.lastAccessedAt) : null, retentionCategory: input.retentionCategory ?? null, sizeBytes: input.sizeBytes ?? null, discoveredVia: existing?.discoveredVia ?? src.via,
        lastScanId: src.scanId ?? existing?.lastScanId ?? null,
      };
      let asset: AssetRow;
      if (existing) {
        [asset] = (await tx.update(dataAssets).set({ ...base, updatedAt: now }).where(eq(dataAssets.id, existing.id)).returning()) as [AssetRow];
      } else {
        [asset] = (await tx.insert(dataAssets).values(base).returning()) as [AssetRow];
      }

      // Classifications: replace machine results; keep human reviews.
      if (classify) {
        const prior = await tx.select().from(dataClassifications).where(eq(dataClassifications.assetId, asset.id));
        const seen = new Set(summaries.map((s) => s.category));
        const stale = prior.filter((p) => !seen.has(p.category) && p.reviewStatus === "unreviewed" && p.detectionMethod !== "manual");
        if (stale.length) await tx.delete(dataClassifications).where(inArray(dataClassifications.id, stale.map((p) => p.id)));
        for (const s of summaries) {
          const method = s.methods.includes("checksum") ? "checksum" : s.methods[0]!;
          await tx.insert(dataClassifications).values({
            organizationId: orgId, assetId: asset.id, category: s.category, sensitivity: sensitivityOf(s.category, rules.custom), detectionMethod: method, detectors: s.detectors,
            confidence: s.confidence, confidenceBasis: s.basis.join("; ").slice(0, 1000), matchCount: s.count, scanId: src.scanId ?? null,
          }).onConflictDoUpdate({
            target: [dataClassifications.assetId, dataClassifications.category],
            set: { detectionMethod: method, detectors: s.detectors, confidence: s.confidence, confidenceBasis: s.basis.join("; ").slice(0, 1000), matchCount: s.count, scanId: src.scanId ?? null },
          });
        }
      }
      const cls = await tx.select().from(dataClassifications).where(and(eq(dataClassifications.assetId, asset.id), ne(dataClassifications.reviewStatus, "rejected")));
      const effective = cls.map((c) => ({ category: c.category, count: c.matchCount, confidence: c.reviewStatus === "confirmed" || c.detectionMethod === "manual" ? ("high" as const) : c.confidence, methods: [], detectors: [], basis: [], redactable: 0 } as CategorySummary));
      const sensitivity: Sensitivity = asset.classificationLocked ? asset.classification : overallSensitivity(effective, rules.custom);
      const categories = effective.filter((c) => c.confidence !== "low").map((c) => c.category).sort();

      // Permission findings.
      const found = analyzeAccess({ sensitivity, permissions: perms, hasOwner: !!(owner?.id ?? asset.ownerUserId) }, { now, inactiveEmails: inactive, broadGroupSize: st.broadGroupSize });
      let opened = 0;
      const keep: string[] = [];
      for (const f of found) {
        const [row] = await tx.insert(accessFindings).values({ organizationId: orgId, assetId: asset.id, kind: f.kind, severity: f.severity, principal: f.principal ?? "", detail: f.detail })
          .onConflictDoUpdate({ target: [accessFindings.assetId, accessFindings.kind, accessFindings.principal], set: { severity: f.severity, detail: f.detail, lastSeenAt: now, status: sql`case when ${accessFindings.status} = 'resolved' then 'open' else ${accessFindings.status} end`, resolvedAt: sql`case when ${accessFindings.status} = 'resolved' then null else ${accessFindings.resolvedAt} end` } })
          .returning({ id: accessFindings.id, firstSeenAt: accessFindings.firstSeenAt });
        keep.push(row!.id);
        if (row!.firstSeenAt.getTime() >= now.getTime() - 1000) opened++;
        if (f.recommendation && SEVERITY_RANK[f.severity] >= SEVERITY_RANK.medium) {
          const titles = { remove_broad_sharing: `Remove broad sharing on "${asset.name}"`, restrict_group: `Restrict access for ${f.principal ?? "a principal"} on "${asset.name}"`, assign_owner: `Assign an owner to "${asset.name}"` } as const;
          await recommend(tx, orgId, { action: f.recommendation, title: titles[f.recommendation], detail: f.detail, dedupeKey: `access:${asset.id}:${f.kind}:${f.principal ?? ""}`, assetId: asset.id, findingType: "access", findingId: row!.id, params: f.principal ? { principal: f.principal } : {} });
        }
      }
      await tx.update(accessFindings).set({ status: "resolved", resolvedAt: now, resolutionNote: "No longer observed in the latest scan." })
        .where(and(eq(accessFindings.assetId, asset.id), eq(accessFindings.status, "open"), keep.length ? not(inArray(accessFindings.id, keep)) : undefined));

      // Inferred AI exposure.
      const exposures = inferExposure({ sensitivity, sourceSystem: input.sourceSystem, permissions: perms });
      const keepExp: string[] = [];
      for (const e of exposures) {
        const [row] = await tx.insert(exposureFindings).values({ organizationId: orgId, assetId: asset.id, exposureType: e.type, basis: "inferred", severity: e.severity, detail: e.detail })
          .onConflictDoUpdate({ target: [exposureFindings.assetId, exposureFindings.exposureType, exposureFindings.basis, exposureFindings.destination], set: { severity: e.severity, detail: e.detail, lastSeenAt: now, status: sql`case when ${exposureFindings.status} = 'resolved' then 'open' else ${exposureFindings.status} end` } })
          .returning({ id: exposureFindings.id });
        keepExp.push(row!.id);
      }
      await tx.update(exposureFindings).set({ status: "resolved" }).where(and(eq(exposureFindings.assetId, asset.id), eq(exposureFindings.basis, "inferred"), eq(exposureFindings.status, "open"), keepExp.length ? not(inArray(exposureFindings.id, keepExp)) : undefined));
      const exposure = await exposureStatus(tx, asset.id);

      const changed = !existing || existing.classification !== sensitivity || existing.categories.join() !== categories.join() || existing.sharingScope !== base.sharingScope || existing.ownerUserId !== base.ownerUserId || (classify && existing.contentFingerprint !== contentFp);
      const [u] = await tx.update(dataAssets).set({
        classification: sensitivity, categories, aiExposureStatus: exposure, ...(classify ? { contentFingerprint: contentFp, lastClassifiedAt: now } : {}),
        ...(changed && existing ? { currentVersion: sql`${dataAssets.currentVersion} + 1` } : {}),
      }).where(eq(dataAssets.id, asset.id)).returning();
      if (changed) await tx.insert(dataAssetVersions).values({ organizationId: orgId, assetId: asset.id, version: u!.currentVersion, snapshot: snapshotOf(u!), changeNote: existing ? "Rescanned: metadata or classification changed" : "Discovered", createdBy: userId(src.actor) });
      return { asset: u!, created: !existing, classificationChanged: !existing || existing.classification !== sensitivity, opened };
    });
    if (res.classificationChanged && SENSITIVITY_RANK[res.asset.classification] >= SENSITIVITY_RANK.confidential) {
      await bus.publish(src.actor, "data_security.asset.classified", { assetId: res.asset.id, classification: res.asset.classification, categories: res.asset.categories });
    }
    return res;
  }

  function snapshotOf(a: AssetRow): Record<string, unknown> {
    return { name: a.name, location: a.location, ownerUserId: a.ownerUserId, ownerLabel: a.ownerLabel, department: a.department, classification: a.classification, categories: a.categories, sharingScope: a.sharingScope, permissions: a.permissions, retentionCategory: a.retentionCategory };
  }
  async function exposureStatus(tx: Tx, assetId: string): Promise<"none" | "potential" | "observed"> {
    const rows = await tx.select({ basis: exposureFindings.basis }).from(exposureFindings).where(and(eq(exposureFindings.assetId, assetId), eq(exposureFindings.status, "open")));
    return rows.some((r) => r.basis === "observed") ? "observed" : rows.length ? "potential" : "none";
  }

  // ── Destinations / shadow AI tools ──────────────────────────────────────
  async function upsertTool(tx: Tx, orgId: string, t: { catalogKey?: string | null; vendor: string; name: string; category: string; domains: string[]; source: "telemetry" | "manual" | "platform"; status?: ToolStatus }) {
    const [existing] = await tx.select().from(shadowAiTools).where(and(eq(shadowAiTools.organizationId, orgId), eq(shadowAiTools.vendor, t.vendor), eq(shadowAiTools.name, t.name))).limit(1);
    if (existing) {
      const domains = [...new Set([...existing.domains, ...t.domains])];
      if (domains.length !== existing.domains.length) await tx.update(shadowAiTools).set({ domains }).where(eq(shadowAiTools.id, existing.id));
      return { tool: existing, created: false };
    }
    const [row] = await tx.insert(shadowAiTools).values({ organizationId: orgId, catalogKey: t.catalogKey ?? null, vendor: t.vendor, name: t.name, category: t.category, domains: t.domains, source: t.source, status: t.status ?? "unknown" }).onConflictDoNothing().returning();
    if (row) return { tool: row, created: true };
    const [again] = await tx.select().from(shadowAiTools).where(and(eq(shadowAiTools.organizationId, orgId), eq(shadowAiTools.vendor, t.vendor), eq(shadowAiTools.name, t.name))).limit(1);
    return { tool: again!, created: false };
  }

  async function resolveDestination(orgId: string, raw: string): Promise<Destination & { created: boolean; tool: ToolRow | null }> {
    const domain = normalizeDomain(raw);
    return orgScope(orgId, async (tx) => {
      const tools = await tx.select().from(shadowAiTools).where(eq(shadowAiTools.organizationId, orgId));
      const byDomain = domain ? tools.find((t) => t.domains.some((d) => domain === d || domain.endsWith(`.${d}`))) : undefined;
      const byName = tools.find((t) => t.name.toLowerCase() === raw.trim().toLowerCase() || `${t.vendor} ${t.name}`.toLowerCase() === raw.trim().toLowerCase());
      let tool = byDomain ?? byName ?? null;
      let created = false;
      if (!tool) {
        const cat = domain ? matchCatalog(domain) : null;
        const r = await upsertTool(tx, orgId, cat ? { catalogKey: cat.key, vendor: cat.vendor, name: cat.name, category: cat.category, domains: cat.domains, source: "telemetry" } : { vendor: domain ?? raw.trim().slice(0, 120), name: domain ?? raw.trim().slice(0, 120), category: "other", domains: domain ? [domain] : [], source: "telemetry" });
        tool = r.tool;
        created = r.created;
      }
      return { name: tool.name, trust: tool.status, category: tool.category, toolId: tool.id, created, tool };
    });
  }

  // ── Incidents ───────────────────────────────────────────────────────────
  async function openOrAppend(ctx: TenantContext, i: { kind: IncidentKind; severity: Severity; title: string; description: string; source: string; dedupeKey: string; assetIds?: string[]; users?: string[]; evidence: string; data?: Record<string, unknown>; toolId?: string | null }) {
    const orgId = ctx.organizationId;
    const res = await orgScope(orgId, async (tx) => {
      const [open] = await tx.select().from(securityIncidents).where(and(eq(securityIncidents.organizationId, orgId), eq(securityIncidents.dedupeKey, i.dedupeKey), ne(securityIncidents.status, "resolved"), gte(securityIncidents.createdAt, new Date(Date.now() - 24 * 3600_000)))).limit(1);
      if (open) {
        const severity = SEVERITY_RANK[i.severity] > SEVERITY_RANK[open.severity] ? i.severity : open.severity;
        const [u] = await tx.update(securityIncidents).set({
          severity, eventCount: open.eventCount + 1, updatedAt: new Date(),
          affectedAssetIds: [...new Set([...open.affectedAssetIds, ...(i.assetIds ?? [])])].slice(0, 200), affectedUsers: [...new Set([...open.affectedUsers, ...(i.users ?? [])])].slice(0, 200),
        }).where(eq(securityIncidents.id, open.id)).returning();
        await tx.insert(incidentEvents).values({ organizationId: orgId, incidentId: open.id, kind: "evidence", message: i.evidence, data: i.data ?? null, actorLabel: "system:data_security" });
        if (severity !== open.severity) await tx.insert(incidentEvents).values({ organizationId: orgId, incidentId: open.id, kind: "severity_change", message: `Severity raised to ${severity}.`, actorLabel: "system:data_security" });
        return { incident: u!, created: false };
      }
      const [row] = await tx.insert(securityIncidents).values({ organizationId: orgId, kind: i.kind, severity: i.severity, title: i.title, description: i.description, source: i.source, dedupeKey: i.dedupeKey, affectedAssetIds: i.assetIds ?? [], affectedUsers: i.users ?? [], openedBy: userId(ctx) }).returning();
      await tx.insert(incidentEvents).values({ organizationId: orgId, incidentId: row!.id, kind: "created", message: i.evidence, data: i.data ?? null, actorLabel: ctx.actor.label });
      if (i.kind === "credential_exposure") await recommend(tx, orgId, { action: "rotate_credential", title: "Rotate the exposed credential(s)", detail: "Credentials were detected in content headed to AI. Rotate them in the issuing system and review where else they were used.", dedupeKey: `incident:${row!.id}:rotate`, incidentId: row!.id, findingType: "incident", findingId: row!.id });
      if ((i.kind === "unauthorized_ai" || i.kind === "restricted_data_access") && i.toolId) await recommend(tx, orgId, { action: "block_ai_destination", title: "Block this AI destination", detail: "Sensitive data was sent or attempted to an AI destination the organization has not approved.", dedupeKey: `tool:${i.toolId}:block`, toolId: i.toolId, incidentId: row!.id, findingType: "incident", findingId: row!.id });
      return { incident: row!, created: true };
    });
    if (res.created) {
      await record(ctx, "data_security.incident_created", "security_incident", res.incident.id, { after: { kind: i.kind, severity: i.severity, title: i.title, source: i.source } });
      await bus.publish(ctx, "security.incident.created", { incidentId: res.incident.id, kind: i.kind, severity: i.severity, source: i.source });
      await notifications.notify(ctx, { type: "data_security.incident", title: `Security incident: ${i.title}`, body: i.description.slice(0, 400), actionUrl: `${BASE}/incidents/${res.incident.id}`, priority: i.severity === "critical" ? "critical" : i.severity === "high" ? "high" : "normal", recipients: { permission: "data_security.incident.manage" } });
    }
    return res.incident;
  }

  // ── DLP core ────────────────────────────────────────────────────────────
  interface DlpInput { parts: string[]; destination: Destination; source: "ai_gateway" | "api"; moduleId?: string; useCase?: string; assetIds?: string[]; userEmail?: string }
  async function evaluateDlp(ctx: TenantContext, input: DlpInput) {
    const orgId = ctx.organizationId;
    const rules = await loadRules(orgId);
    const st = await settings(orgId);
    const perPart = input.parts.map((p) => detect(p, { customRules: rules.custom }));
    const all = perPart.flat();
    const summaries = summarize(all);
    const joined = input.parts.join("\n\n");
    const chars = joined.length;
    const dest = input.destination;
    const outcome = decideDlp(summaries, dest.trust, rules.actions);
    const sensitivity = overallSensitivity(summaries, rules.custom);
    const counts = Object.fromEntries(summaries.map((s) => [s.category, s.count]));

    // Organization "ai_dlp" policies (shared engine) can only tighten.
    const pol = await policies.evaluateKind(ctx, "ai_dlp", {
      subject: { type: ctx.actor.type, id: ctx.actor.id, attributes: { label: ctx.actor.label } },
      resource: { type: "ai_destination", id: dest.name, attributes: { trust: dest.trust, category: dest.category, toolId: dest.toolId } },
      action: "ai.send",
      context: { categories: summaries.filter((s) => s.confidence !== "low").map((s) => s.category), counts, sensitivity, chars, moduleId: input.moduleId ?? null, useCase: input.useCase ?? null, source: input.source },
    }, { defaultEffect: "ALLOW" });
    let decision: DlpDecision = stricter(outcome.decision, fromPolicyEffect(pol.effect));
    const reasons = [...outcome.reasons, ...(pol.defaulted ? [] : pol.reasons.map((r) => `policy: ${r}`))];
    const redactCategories = decision === "REDACT" ? outcome.redactCategories : [];

    // Large AI-bound exports never pass silently to non-approved destinations.
    const large = chars >= st.largeExportChars;
    if (large && dest.trust !== "approved") {
      decision = stricter(decision, "REQUIRE_APPROVAL");
      reasons.push(`Large export (${chars.toLocaleString("en-US")} characters) to a ${dest.trust} destination needs approval.`);
    }

    const fp = await fingerprint(orgId, `${dest.name}\u0000${joined}`);
    let approvedVia: string | null = null;
    if (decision === "REQUIRE_APPROVAL") {
      const [ok] = await orgScope(orgId, (tx) =>
        tx.update(dlpEvents).set({ approvalStatus: "used" }).where(and(eq(dlpEvents.organizationId, orgId), eq(dlpEvents.actorId, ctx.actor.id), eq(dlpEvents.destination, dest.name), eq(dlpEvents.contentFingerprint, fp), eq(dlpEvents.approvalStatus, "approved"), sql`${dlpEvents.approvalExpiresAt} > now()`)).returning(),
      );
      if (ok) {
        decision = "ALLOW";
        approvedVia = ok.id;
        reasons.push(`Approved by a reviewer (DLP event ${ok.id.slice(0, 8)}); single use.`);
      }
    }

    // Redaction (only for spans in REDACT categories at their minimum confidence).
    let redactedParts: string[] | null = null;
    let redactionInfo: { count: number; byLabel: Record<string, number>; modes: string[] } | null = null;
    if (decision === "REDACT") {
      const tokenKey = await orgKey(orgId);
      const cats = new Set(redactCategories);
      const eligible = (m: Match) => cats.has(m.category) && CONFIDENCE_RANK[m.confidence] >= CONFIDENCE_RANK[actionFor(m.category, rules.actions).minConfidence];
      const modes = new Set<string>();
      let count = 0;
      const byLabel: Record<string, number> = {};
      redactedParts = input.parts.map((p, i) => {
        const r = redact(p, perPart[i]!.filter(eligible), { mode: (m) => { const md = actionFor(m.category, rules.actions).redactionMode; modes.add(md); return md; }, tokenKey });
        count += r.redacted;
        for (const [k, v] of Object.entries(r.byLabel)) byLabel[k] = (byLabel[k] ?? 0) + v;
        return r.text;
      });
      redactionInfo = { count, byLabel, modes: [...modes] };
    }

    const retain = st.contentRetention === "redacted_preview" && (await organizations.settingsInternal(orgId)).dataRetention.aiPromptRetention !== "none";
    const detections: DetectionSummary[] = summaries.map((s) => ({ category: s.category, count: s.count, confidence: s.confidence, methods: s.methods, detectors: s.detectors, basis: s.basis }));
    const triggered = summaries.filter((s) => s.confidence !== "low").map((s) => s.category);
    const validAssets = input.assetIds?.length ? (await orgScope(orgId, (tx) => tx.select({ id: dataAssets.id, classification: dataAssets.classification }).from(dataAssets).where(and(eq(dataAssets.organizationId, orgId), inArray(dataAssets.id, input.assetIds!))))) : [];
    let uid: string | null = ctx.actor.type === "user" ? ctx.actor.id : null;
    if (!uid && input.userEmail) uid = (await orgScope(orgId, (tx) => memberByEmail(tx, orgId, input.userEmail)))?.id ?? null;
    const actorLabel = input.userEmail ? `${ctx.actor.label} (for ${input.userEmail})` : ctx.actor.label;

    const event = await orgScope(orgId, async (tx) => {
      const [e] = await tx.insert(dlpEvents).values({
        organizationId: orgId, source: input.source, actorType: ctx.actor.type, actorId: ctx.actor.id, actorLabel: actorLabel.slice(0, 300), userId: uid, destination: dest.name, destinationTrust: dest.trust, destinationCategory: dest.category,
        toolId: dest.toolId, moduleId: input.moduleId ?? null, useCase: input.useCase ?? null, decision, reasons: reasons.slice(0, 30), detections, categories: triggered, policies: pol.policies,
        contentFingerprint: fp, contentChars: chars, redactedPreview: retain ? safePreview(joined, all) : null, assetIds: validAssets.map((a) => a.id),
        approvalStatus: decision === "REQUIRE_APPROVAL" ? "pending" : null, approvalExpiresAt: decision === "REQUIRE_APPROVAL" ? new Date(Date.now() + APPROVAL_REQUEST_DAYS * 86400_000) : null, approvedVia,
      }).returning();
      if (redactionInfo && redactedParts) {
        await tx.insert(redactionEvents).values({ organizationId: orgId, dlpEventId: e!.id, modes: redactionInfo.modes, categories: redactCategories, byLabel: redactionInfo.byLabel, redactedCount: redactionInfo.count, outputFingerprint: hmacSha256(await orgKey(orgId), redactedParts.join("\n\n")) });
      }
      // Observed AI exposure for referenced assets.
      for (const a of validAssets) {
        const f = observedExposure({ trust: dest.trust, category: dest.category, actorType: ctx.actor.type }, decision, a.classification);
        await tx.insert(exposureFindings).values({ organizationId: orgId, assetId: a.id, exposureType: f.type, toolId: dest.toolId, destination: dest.name, basis: "observed", severity: f.severity, detail: f.detail })
          .onConflictDoUpdate({ target: [exposureFindings.assetId, exposureFindings.exposureType, exposureFindings.basis, exposureFindings.destination], set: { severity: f.severity, detail: f.detail, lastSeenAt: new Date(), status: "open" } });
        await tx.update(dataAssets).set({ aiExposureStatus: "observed" }).where(eq(dataAssets.id, a.id));
      }
      return e!;
    });

    // Incidents.
    const who = input.userEmail ?? ctx.actor.label;
    const sensitive = SENSITIVITY_RANK[sensitivity] >= SENSITIVITY_RANK.confidential;
    let incidentId: string | null = null;
    const attach = (i: IncidentRow) => {
      incidentId ??= i.id;
    };
    if (triggered.includes("credentials")) {
      attach(await openOrAppend(ctx, { kind: "credential_exposure", severity: decision === "BLOCK" ? "high" : "critical", title: `Credentials in AI-bound content (${who})`, description: `Credentials were detected in content headed to ${dest.name}. Decision: ${decision}.`, source: input.source, dedupeKey: `cred:${ctx.actor.id}:${dest.name}`, assetIds: validAssets.map((a) => a.id), users: [who], evidence: `DLP event ${event.id}: ${detections.find((d) => d.category === "credentials")?.count ?? 0} credential(s), decision ${decision}.`, data: { dlpEventId: event.id } }));
    }
    if (sensitive && dest.trust !== "approved" && triggered.length) {
      const restricted = SENSITIVITY_RANK[sensitivity] >= SENSITIVITY_RANK.restricted;
      attach(await openOrAppend(ctx, { kind: "unauthorized_ai", severity: decision === "BLOCK" ? (restricted ? "high" : "medium") : restricted ? "critical" : "high", title: `Sensitive data to ${dest.trust} AI: ${dest.name}`, description: `${triggered.join(", ")} sent or attempted to ${dest.name} (${dest.trust}). Decision: ${decision}.`, source: input.source, dedupeKey: `unauth:${ctx.actor.id}:${dest.name}`, assetIds: validAssets.map((a) => a.id), users: [who], evidence: `DLP event ${event.id}: ${triggered.join(", ")} → ${decision}.`, data: { dlpEventId: event.id }, toolId: dest.toolId }));
    }
    if (large && (sensitive || dest.trust !== "approved")) {
      attach(await openOrAppend(ctx, { kind: "large_ai_export", severity: sensitive ? "high" : "medium", title: `Large AI-bound export (${who})`, description: `${chars.toLocaleString("en-US")} characters headed to ${dest.name}.`, source: input.source, dedupeKey: `large:${ctx.actor.id}:${dest.name}`, users: [who], evidence: `DLP event ${event.id}: ${chars} characters, decision ${decision}.`, data: { dlpEventId: event.id } }));
    }
    if (!pol.defaulted && pol.effect === "DENY") {
      attach(await openOrAppend(ctx, { kind: "policy_violation", severity: "medium", title: `AI DLP policy violation (${who})`, description: pol.reasons.slice(0, 3).join("; "), source: input.source, dedupeKey: `policy:${ctx.actor.id}`, users: [who], evidence: `DLP event ${event.id}: blocked by ${pol.policies.map((p) => p.key).join(", ")}.`, data: { dlpEventId: event.id } }));
    }
    if (decision === "BLOCK") {
      const [n] = await orgScope(orgId, (tx) => tx.select({ n: sql<number>`count(*)::int` }).from(dlpEvents).where(and(eq(dlpEvents.organizationId, orgId), eq(dlpEvents.actorId, ctx.actor.id), eq(dlpEvents.decision, "BLOCK"), gte(dlpEvents.createdAt, new Date(Date.now() - 3600_000)))));
      if ((n?.n ?? 0) >= st.abnormalBlockedPerHour) {
        attach(await openOrAppend(ctx, { kind: "abnormal_ai_activity", severity: "high", title: `Abnormal AI activity (${who})`, description: `${n!.n} blocked AI transmissions in the last hour.`, source: input.source, dedupeKey: `abnormal:${ctx.actor.id}`, users: [who], evidence: `DLP event ${event.id}: ${n!.n} blocked in 1 h (threshold ${st.abnormalBlockedPerHour}).`, data: { dlpEventId: event.id } }));
      }
    }
    if (incidentId) await orgScope(orgId, (tx) => tx.update(dlpEvents).set({ incidentId }).where(eq(dlpEvents.id, event.id)));

    if (decision !== "ALLOW") await record(ctx, `data_security.dlp_${decision.toLowerCase()}`, "dlp_event", event.id, { outcome: decision === "BLOCK" ? "denied" : "success", metadata: { destination: dest.name, trust: dest.trust, categories: triggered, chars } });
    if (decision === "BLOCK") await bus.publish(ctx, "data_security.dlp.blocked", { dlpEventId: event.id, destination: dest.name, categories: triggered });
    if (decision === "REDACT") await bus.publish(ctx, "data_security.dlp.redacted", { dlpEventId: event.id, destination: dest.name, categories: redactCategories, redactedCount: redactionInfo?.count ?? 0 });
    if (decision === "REQUIRE_APPROVAL") {
      await bus.publish(ctx, "data_security.dlp.approval_required", { dlpEventId: event.id, destination: dest.name, categories: triggered });
      await notifications.notify(ctx, { type: "data_security.dlp_approval", title: `AI data transfer needs approval: ${who} → ${dest.name}`, body: reasons.slice(0, 3).join(" "), actionUrl: `${BASE}/dlp?focus=${event.id}`, priority: "high", recipients: { permission: "data_security.policy.manage" } });
    }
    await usage.record(ctx, { moduleId: MODULE_ID, metric: "data_security.dlp_evaluations", unit: "evaluation", quantity: 1, dimensions: { decision, source: input.source } });
    // For anything not sent as-is, a fully label-redacted copy (every detected span) for logs.
    const sanitizedParts = decision === "ALLOW" ? null : input.parts.map((p, i) => redact(p, perPart[i]!, { mode: "label" }).text);
    return { eventId: event.id, decision, reasons, categories: triggered, detections, redactedParts, sanitizedParts, redactedCount: redactionInfo?.count ?? 0, incidentId };
  }

  // ── Tool aggregates ─────────────────────────────────────────────────────
  async function refreshTool(tx: Tx, toolId: string) {
    const since = new Date(Date.now() - 90 * 86400_000);
    const [agg] = await tx.select({
      users: sql<number>`count(distinct coalesce(${shadowAiUsage.userId}::text, ${shadowAiUsage.userFingerprint}))::int`,
      departments: sql<string[]>`coalesce(array_agg(distinct ${shadowAiUsage.department}) filter (where ${shadowAiUsage.department} is not null), '{}')`,
      cats: sql<string[]>`coalesce((select array_agg(distinct c) from ${shadowAiUsage} u2, unnest(u2.data_categories) c where u2.tool_id = ${toolId} and u2.occurred_at >= ${since}), '{}')`,
      last: sql<Date | null>`max(${shadowAiUsage.occurredAt})`,
    }).from(shadowAiUsage).where(and(eq(shadowAiUsage.toolId, toolId), gte(shadowAiUsage.occurredAt, since)));
    const [t] = await tx.select().from(shadowAiTools).where(eq(shadowAiTools.id, toolId)).limit(1);
    const dataCategories = [...new Set([...(agg?.cats ?? [])])].sort();
    const risk = toolRisk({ status: t!.status, dataCategories, userCount: agg?.users ?? 0 });
    await tx.update(shadowAiTools).set({
      userCount: agg?.users ?? 0, departments: (agg?.departments ?? []).sort(), dataCategories, riskScore: risk.score, riskLevel: risk.level, riskFactors: risk.factors,
      ...(agg?.last ? { lastSeenAt: sql`greatest(${shadowAiTools.lastSeenAt}, ${new Date(agg.last)})` } : {}),
    }).where(eq(shadowAiTools.id, toolId));
  }

  const service = {
    // ── Settings ──────────────────────────────────────────────────────────
    async getSettings(ctx: TenantContext) {
      await authorizer.require(ctx, "data_security.read");
      const s = await settings(org(ctx));
      return { contentRetention: s.contentRetention, largeExportChars: s.largeExportChars, abnormalBlockedPerHour: s.abnormalBlockedPerHour, broadGroupSize: s.broadGroupSize, tokenizationKeyConfigured: !!s.tokenizationSecretRef };
    },
    async updateSettings(ctx: TenantContext, raw: unknown) {
      await authorizer.require(ctx, "data_security.policy.manage");
      const input = parse(settingsSchema, raw);
      const before = await settings(org(ctx));
      await tenant(ctx, (tx) => tx.update(dsSettings).set({ ...input, updatedBy: userId(ctx), updatedAt: new Date() }).where(eq(dsSettings.organizationId, org(ctx))));
      await record(ctx, "data_security.settings_updated", "data_security_settings", org(ctx), { before: { contentRetention: before.contentRetention, largeExportChars: before.largeExportChars, abnormalBlockedPerHour: before.abnormalBlockedPerHour, broadGroupSize: before.broadGroupSize }, after: input });
      return service.getSettings(ctx);
    },

    // ── Inventory ─────────────────────────────────────────────────────────
    async listAssets(ctx: TenantContext, q: { classification?: string; exposure?: string; q?: string; source?: string; category?: string } = {}) {
      await authorizer.require(ctx, "data_security.read");
      return tenant(ctx, async (tx) => {
        const like = q.q ? `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
        const rows = await tx.select({ a: dataAssets, ownerName: users.name }).from(dataAssets).leftJoin(users, eq(users.id, dataAssets.ownerUserId))
          .where(and(eq(dataAssets.organizationId, org(ctx)), q.classification ? eq(dataAssets.classification, q.classification as Sensitivity) : undefined, q.exposure ? eq(dataAssets.aiExposureStatus, q.exposure as "none") : undefined,
            q.source ? eq(dataAssets.sourceSystem, q.source) : undefined, q.category ? sql`${q.category} = any(${dataAssets.categories})` : undefined, like ? or(ilike(dataAssets.name, like), ilike(dataAssets.location, like)) : undefined))
          .orderBy(desc(sql`case ${dataAssets.classification} when 'restricted' then 3 when 'confidential' then 2 when 'internal' then 1 else 0 end`), dataAssets.name).limit(2000);
        const findings = await tx.select({ assetId: accessFindings.assetId, n: sql<number>`count(*)::int`, worst: sql<string>`max(case ${accessFindings.severity} when 'critical' then 'd' when 'high' then 'c' when 'medium' then 'b' else 'a' end)` })
          .from(accessFindings).where(and(eq(accessFindings.organizationId, org(ctx)), eq(accessFindings.status, "open"))).groupBy(accessFindings.assetId);
        const fm = new Map(findings.map((f) => [f.assetId, f]));
        const sev: Record<string, Severity> = { a: "low", b: "medium", c: "high", d: "critical" };
        return rows.map(({ a, ownerName }) => ({ ...assetView(a, ownerName), openFindings: fm.get(a.id)?.n ?? 0, worstFinding: fm.get(a.id) ? sev[fm.get(a.id)!.worst]! : null }));
      });
    },

    async getAsset(ctx: TenantContext, id: string) {
      await authorizer.require(ctx, "data_security.read");
      uuidOr404(id, "Asset");
      return tenant(ctx, async (tx) => {
        const [row] = await tx.select({ a: dataAssets, ownerName: users.name }).from(dataAssets).leftJoin(users, eq(users.id, dataAssets.ownerUserId)).where(and(eq(dataAssets.organizationId, org(ctx)), eq(dataAssets.id, id))).limit(1);
        if (!row) throw notFound("Asset", id);
        const cls = await tx.select().from(dataClassifications).where(eq(dataClassifications.assetId, id)).orderBy(desc(dataClassifications.matchCount));
        const access = await tx.select().from(accessFindings).where(eq(accessFindings.assetId, id)).orderBy(desc(accessFindings.lastSeenAt));
        const exposure = await tx.select().from(exposureFindings).where(eq(exposureFindings.assetId, id)).orderBy(desc(exposureFindings.lastSeenAt));
        const rem = await tx.select().from(remediationActions).where(eq(remediationActions.assetId, id)).orderBy(desc(remediationActions.createdAt));
        const versions = await tx.select({ version: dataAssetVersions.version, changeNote: dataAssetVersions.changeNote, createdAt: dataAssetVersions.createdAt }).from(dataAssetVersions).where(eq(dataAssetVersions.assetId, id)).orderBy(desc(dataAssetVersions.version)).limit(30);
        return {
          ...assetView(row.a, row.ownerName),
          classifications: cls.map((c) => ({ id: c.id, category: c.category, label: (CATEGORY_META as Record<string, { label: string }>)[c.category]?.label ?? c.category, sensitivity: c.sensitivity, method: c.detectionMethod, detectors: c.detectors, confidence: c.confidence, basis: c.confidenceBasis, matchCount: c.matchCount, reviewStatus: c.reviewStatus, reviewedAt: iso(c.reviewedAt) })),
          accessFindings: access.map((f) => ({ id: f.id, kind: f.kind, severity: f.severity, principal: f.principal || null, detail: f.detail, status: f.status, firstSeenAt: f.firstSeenAt.toISOString(), lastSeenAt: f.lastSeenAt.toISOString() })),
          exposureFindings: exposure.map((f) => ({ id: f.id, type: f.exposureType, destination: f.destination || null, basis: f.basis, severity: f.severity, detail: f.detail, status: f.status, lastSeenAt: f.lastSeenAt.toISOString() })),
          remediation: rem.map(remediationView),
          versions: versions.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() })),
        };
      });
    },

    async ingestAssets(ctx: TenantContext, raw: unknown) {
      await authorizer.require(ctx, "data_security.scan");
      const input = parse(ingestSchema, raw);
      const [scan] = await tenant(ctx, (tx) => tx.insert(dataScans).values({ organizationId: org(ctx), source: "api", status: "running", params: { sourceSystem: input.sourceSystem, count: input.assets.length }, requestedBy: userId(ctx), startedAt: new Date() }).returning());
      let classified = 0;
      let opened = 0;
      const results: Array<{ externalId: string; assetId: string; classification: string; created: boolean }> = [];
      for (const a of input.assets) {
        const r = await upsertAsset(org(ctx), { ...a, sourceSystem: a.sourceSystem ?? input.sourceSystem }, { via: "api", scanId: scan!.id, actor: ctx });
        if (a.content !== undefined) classified++;
        opened += r.opened;
        results.push({ externalId: a.externalId, assetId: r.asset.id, classification: r.asset.classification, created: r.created });
      }
      await tenant(ctx, (tx) => tx.update(dataScans).set({ status: "succeeded", assetsSeen: input.assets.length, assetsClassified: classified, findingsOpened: opened, finishedAt: new Date() }).where(eq(dataScans.id, scan!.id)));
      await record(ctx, "data_security.assets_ingested", "data_scan", scan!.id, { metadata: { sourceSystem: input.sourceSystem, assets: input.assets.length, classified, findingsOpened: opened } });
      return { scanId: scan!.id, assets: results, findingsOpened: opened };
    },

    async startScan(ctx: TenantContext, raw: unknown) {
      await authorizer.require(ctx, "data_security.scan");
      const input = parse(z.object({ connectorId: z.string().uuid(), path: text(500).optional() }), raw);
      const c = await connectors.get(sysCtx(org(ctx)), input.connectorId).catch((e: unknown) => {
        if (isAppError(e) && e.code === "NOT_FOUND") throw notFound("Connector", input.connectorId);
        throw e;
      });
      const [scan] = await tenant(ctx, (tx) => tx.insert(dataScans).values({ organizationId: org(ctx), connectorId: c.id, source: "connector", status: "queued", params: { path: input.path ?? null, connectorType: c.type }, requestedBy: userId(ctx) }).returning());
      await jobs.enqueue(SCAN_JOB, { scanId: scan!.id }, { organizationId: org(ctx), idempotencyKey: `ds-scan:${scan!.id}`, correlationId: ctx.correlationId });
      await record(ctx, "data_security.scan_started", "data_scan", scan!.id, { metadata: { connectorId: c.id, connectorType: c.type } });
      return { id: scan!.id, status: scan!.status };
    },

    async listScans(ctx: TenantContext) {
      await authorizer.require(ctx, "data_security.read");
      return tenant(ctx, async (tx) => {
        const rows = await tx.select().from(dataScans).where(eq(dataScans.organizationId, org(ctx))).orderBy(desc(dataScans.createdAt)).limit(100);
        return rows.map((s) => ({ id: s.id, source: s.source, connectorId: s.connectorId, status: s.status, params: s.params, assetsSeen: s.assetsSeen, assetsClassified: s.assetsClassified, findingsOpened: s.findingsOpened, errorMessage: s.errorMessage, startedAt: iso(s.startedAt), finishedAt: iso(s.finishedAt), createdAt: s.createdAt.toISOString() }));
      });
    },

    /** Job handler: discover assets through a shared connector. */
    async runScan(orgId: string, scanId: string) {
      const ctx = sysCtx(orgId);
      const [scan] = await orgScope(orgId, (tx) => tx.update(dataScans).set({ status: "running", startedAt: new Date() }).where(and(eq(dataScans.id, scanId), eq(dataScans.status, "queued"))).returning());
      if (!scan || !scan.connectorId) return;
      try {
        const c = await connectors.get(ctx, scan.connectorId);
        let items: unknown[];
        if (c.type === "sandbox") {
          const out = (await connectors.execute(ctx, c.id, { capability: "files.list", operation: "list", params: {} }, { moduleId: MODULE_ID })) as { files?: unknown[] };
          items = out.files ?? [];
        } else if (c.type === "rest_api") {
          const path = String((scan.params as { path?: string }).path ?? "");
          if (!path) throw new AppError("VALIDATION_FAILED", "REST discovery needs the inventory endpoint path (e.g. /inventory/assets).");
          const out = (await connectors.execute(ctx, c.id, { capability: "http.request", operation: "read", params: { method: "GET", path } }, { moduleId: MODULE_ID })) as { body?: unknown };
          const body = out.body as { assets?: unknown[] } | unknown[];
          items = Array.isArray(body) ? body : Array.isArray(body?.assets) ? body.assets : [];
        } else {
          throw new AppError("NOT_IMPLEMENTED", `No discovery adapter for ${c.type} yet. Push its inventory through POST /api/v1/m/data-security/assets/ingest instead.`);
        }
        let classified = 0;
        let opened = 0;
        let seen = 0;
        for (const raw of items.slice(0, 5000)) {
          const r0 = raw as Record<string, unknown>;
          const parsed = assetInputSchema.safeParse({ ...r0, externalId: r0.externalId ?? r0.id, owner: r0.owner ?? null });
          if (!parsed.success) continue;
          seen++;
          const res = await upsertAsset(orgId, { ...parsed.data, sourceSystem: parsed.data.sourceSystem ?? c.type }, { via: "connector", connectorId: c.id, scanId, actor: ctx });
          if (parsed.data.content !== undefined) classified++;
          opened += res.opened;
        }
        await orgScope(orgId, (tx) => tx.update(dataScans).set({ status: "succeeded", assetsSeen: seen, assetsClassified: classified, findingsOpened: opened, finishedAt: new Date() }).where(eq(dataScans.id, scanId)));
        await record(ctx, "data_security.scan_completed", "data_scan", scanId, { metadata: { connectorId: c.id, assets: seen, classified, findingsOpened: opened } });
      } catch (err) {
        const message = isAppError(err) ? err.message : "The connector call failed. See connector health for details.";
        await orgScope(orgId, (tx) => tx.update(dataScans).set({ status: "failed", errorMessage: message.slice(0, 500), finishedAt: new Date() }).where(eq(dataScans.id, scanId)));
        await record(ctx, "data_security.scan_failed", "data_scan", scanId, { outcome: "failure", metadata: { error: message.slice(0, 300) } });
        if (!isAppError(err)) logger.warn("data_security.scan_failed", { error: err instanceof Error ? err.message : String(err) });
      }
    },

    // ── Classification management ─────────────────────────────────────────
    async listRules(ctx: TenantContext) {
      await authorizer.require(ctx, "data_security.read");
      const rows = await tenant(ctx, (tx) => tx.select().from(classificationRules).where(eq(classificationRules.organizationId, org(ctx))).orderBy(classificationRules.key));
      const builtins = CATEGORIES.map((k) => {
        const o = rows.find((r) => r.key === k);
        const d = DEFAULT_ACTIONS[k];
        return { key: k, builtin: true, label: CATEGORY_META[k].label, description: "", sensitivity: CATEGORY_META[k].sensitivity, patterns: [] as string[], keywords: [] as string[], confidence: "medium", actionApproved: o?.actionApproved ?? d.approved, actionUnapproved: o?.actionUnapproved ?? d.unapproved, minConfidence: o?.minConfidence ?? d.minConfidence, redactionMode: o?.redactionMode ?? d.redactionMode, enabled: o?.enabled ?? true, customized: !!o };
      });
      const custom = rows.filter((r) => !r.builtin).map((r) => ({ key: r.key, builtin: false, label: r.label, description: r.description, sensitivity: r.sensitivity, patterns: r.patterns, keywords: r.keywords, confidence: r.confidence, actionApproved: r.actionApproved, actionUnapproved: r.actionUnapproved, minConfidence: r.minConfidence, redactionMode: r.redactionMode, enabled: r.enabled, customized: true }));
      return [...builtins, ...custom];
    },

    async upsertRule(ctx: TenantContext, raw: unknown) {
      await authorizer.require(ctx, "data_security.classification.manage");
      const input = parse(ruleSchema, raw);
      const builtin = (CATEGORIES as readonly string[]).includes(input.key);
      if (!builtin) {
        if (!input.patterns.length && !input.keywords.length) throw new AppError("VALIDATION_FAILED", "A custom classification needs at least one pattern or keyword.");
        for (const p of input.patterns) {
          const err = safePattern(p);
          if (err) throw new AppError("VALIDATION_FAILED", `patterns: ${err}`);
        }
      }
      const d = builtin ? DEFAULT_ACTIONS[input.key as keyof typeof DEFAULT_ACTIONS] : { approved: "REDACT" as const, unapproved: "BLOCK" as const };
      const values = {
        organizationId: org(ctx), key: input.key, builtin, label: builtin ? CATEGORY_META[input.key as keyof typeof CATEGORY_META].label : input.label, description: input.description,
        sensitivity: builtin ? CATEGORY_META[input.key as keyof typeof CATEGORY_META].sensitivity : input.sensitivity, patterns: builtin ? [] : input.patterns, keywords: builtin ? [] : input.keywords, confidence: input.confidence,
        actionApproved: input.actionApproved ?? d.approved, actionUnapproved: input.actionUnapproved ?? d.unapproved, minConfidence: input.minConfidence, redactionMode: input.redactionMode, enabled: input.enabled, createdBy: userId(ctx),
      };
      const [row] = await tenant(ctx, (tx) => tx.insert(classificationRules).values(values).onConflictDoUpdate({ target: [classificationRules.organizationId, classificationRules.key], set: { ...values, updatedAt: new Date() } }).returning());
      await record(ctx, "data_security.classification_rule_saved", "classification_rule", row!.id, { after: { key: input.key, builtin, actionApproved: values.actionApproved, actionUnapproved: values.actionUnapproved, patterns: values.patterns.length, keywords: values.keywords.length } });
      return { key: row!.key };
    },

    async deleteRule(ctx: TenantContext, key: string) {
      await authorizer.require(ctx, "data_security.classification.manage");
      const [row] = await tenant(ctx, (tx) => tx.delete(classificationRules).where(and(eq(classificationRules.organizationId, org(ctx)), eq(classificationRules.key, key))).returning());
      if (!row) throw notFound("Classification rule", key);
      await record(ctx, row.builtin ? "data_security.classification_rule_reset" : "data_security.classification_rule_deleted", "classification_rule", row.id, { before: { key } });
      return { deleted: true };
    },

    async reviewClassification(ctx: TenantContext, id: string, raw: unknown) {
      await authorizer.require(ctx, "data_security.classification.manage");
      const input = parse(z.object({ status: z.enum(["confirmed", "rejected"]) }), raw);
      uuidOr404(id, "Classification");
      const res = await tenant(ctx, async (tx) => {
        const [c] = await tx.update(dataClassifications).set({ reviewStatus: input.status, reviewedBy: userId(ctx), reviewedAt: new Date() }).where(and(eq(dataClassifications.organizationId, org(ctx)), eq(dataClassifications.id, id))).returning();
        if (!c) throw notFound("Classification", id);
        return c;
      });
      await record(ctx, `data_security.classification_${input.status}`, "data_asset", res.assetId, { metadata: { classificationId: id, category: res.category } });
      await recompute(ctx, res.assetId, `Classification ${res.category} ${input.status}`);
      return { id, status: input.status };
    },

    async setAssetClassification(ctx: TenantContext, assetId: string, raw: unknown) {
      await authorizer.require(ctx, "data_security.classification.manage");
      const input = parse(z.object({ classification: sensitivityEnum, lock: z.boolean().default(true), note: text(500).optional() }), raw);
      uuidOr404(assetId, "Asset");
      const before = await tenant(ctx, async (tx) => {
        const [a] = await tx.select().from(dataAssets).where(and(eq(dataAssets.organizationId, org(ctx)), eq(dataAssets.id, assetId))).limit(1);
        if (!a) throw notFound("Asset", assetId);
        const [u] = await tx.update(dataAssets).set({ classification: input.classification, classificationLocked: input.lock, currentVersion: sql`${dataAssets.currentVersion} + 1`, updatedAt: new Date() }).where(eq(dataAssets.id, assetId)).returning();
        await tx.insert(dataAssetVersions).values({ organizationId: org(ctx), assetId, version: u!.currentVersion, snapshot: snapshotOf(u!), changeNote: `Classification set to ${input.classification}${input.lock ? " (locked)" : ""}${input.note ? `: ${input.note}` : ""}`, createdBy: userId(ctx) });
        await tx.update(remediationActions).set({ status: "completed", completedBy: userId(ctx), completedAt: new Date(), result: `Classification set to ${input.classification}.` }).where(and(eq(remediationActions.assetId, assetId), eq(remediationActions.action, "change_classification"), eq(remediationActions.status, "recommended")));
        return a;
      });
      await record(ctx, "data_security.classification_changed", "data_asset", assetId, { before: { classification: before.classification, locked: before.classificationLocked }, after: { classification: input.classification, locked: input.lock }, metadata: { note: input.note } });
      return { id: assetId, classification: input.classification };
    },

    async resolveFinding(ctx: TenantContext, kind: "access" | "exposure", id: string, raw: unknown) {
      await authorizer.require(ctx, "data_security.remediation.manage");
      const input = parse(z.object({ status: z.enum(["resolved", "accepted", "open"]), note: text(1000).optional() }), raw);
      uuidOr404(id, "Finding");
      const row = await tenant(ctx, async (tx) => {
        if (kind === "access") {
          const [f] = await tx.update(accessFindings).set({ status: input.status, resolutionNote: input.note ?? null, resolvedAt: input.status === "open" ? null : new Date() }).where(and(eq(accessFindings.organizationId, org(ctx)), eq(accessFindings.id, id))).returning();
          return f;
        }
        const [f] = await tx.update(exposureFindings).set({ status: input.status }).where(and(eq(exposureFindings.organizationId, org(ctx)), eq(exposureFindings.id, id))).returning();
        if (f) await tx.update(dataAssets).set({ aiExposureStatus: await exposureStatus(tx, f.assetId) }).where(eq(dataAssets.id, f.assetId));
        return f;
      });
      if (!row) throw notFound("Finding", id);
      await record(ctx, `data_security.${kind}_finding_${input.status}`, "data_asset", row.assetId, { metadata: { findingId: id, note: input.note } });
      return { id, status: input.status };
    },

    async listFindings(ctx: TenantContext, q: { status?: string; severity?: string } = {}) {
      await authorizer.require(ctx, "data_security.read");
      return tenant(ctx, async (tx) => {
        const rows = await tx.select({ f: accessFindings, assetName: dataAssets.name, classification: dataAssets.classification, sourceSystem: dataAssets.sourceSystem }).from(accessFindings).innerJoin(dataAssets, eq(dataAssets.id, accessFindings.assetId))
          .where(and(eq(accessFindings.organizationId, org(ctx)), eq(accessFindings.status, (q.status ?? "open") as "open"), q.severity ? eq(accessFindings.severity, q.severity as Severity) : undefined))
          .orderBy(desc(sql`case ${accessFindings.severity} when 'critical' then 3 when 'high' then 2 when 'medium' then 1 else 0 end`), desc(sql`case ${dataAssets.classification} when 'restricted' then 3 when 'confidential' then 2 when 'internal' then 1 else 0 end`), desc(accessFindings.lastSeenAt)).limit(1000);
        const exp = await tx.select({ f: exposureFindings, assetName: dataAssets.name, classification: dataAssets.classification }).from(exposureFindings).innerJoin(dataAssets, eq(dataAssets.id, exposureFindings.assetId))
          .where(and(eq(exposureFindings.organizationId, org(ctx)), eq(exposureFindings.status, (q.status ?? "open") as "open"))).orderBy(desc(sql`case ${exposureFindings.severity} when 'critical' then 3 when 'high' then 2 when 'medium' then 1 else 0 end`)).limit(1000);
        return {
          access: rows.map(({ f, assetName, classification, sourceSystem }) => ({ id: f.id, assetId: f.assetId, assetName, classification, sourceSystem, kind: f.kind, severity: f.severity, principal: f.principal || null, detail: f.detail, status: f.status, lastSeenAt: f.lastSeenAt.toISOString() })),
          exposure: exp.map(({ f, assetName, classification }) => ({ id: f.id, assetId: f.assetId, assetName, classification, type: f.exposureType, destination: f.destination || null, basis: f.basis, severity: f.severity, detail: f.detail, status: f.status, lastSeenAt: f.lastSeenAt.toISOString() })),
        };
      });
    },

    // ── DLP ───────────────────────────────────────────────────────────────
    /** Enforcement-point API: evaluate content headed to an AI destination. Returns the decision and, for REDACT, the redacted content. */
    async evaluate(ctx: TenantContext, raw: unknown) {
      await authorizer.require(ctx, "data_security.scan");
      const input = parse(evaluateSchema, raw);
      const dest = await resolveDestination(org(ctx), input.destination);
      if (dest.created) await announceTool(ctx, dest.tool!);
      const r = await evaluateDlp(ctx, { parts: [input.content], destination: dest, source: "api", assetIds: input.assetIds, userEmail: input.userEmail });
      return { eventId: r.eventId, decision: r.decision, reasons: r.reasons, categories: r.categories, detections: r.detections, destination: { name: dest.name, status: dest.trust, toolId: dest.toolId }, content: r.decision === "REDACT" ? r.redactedParts![0] : r.decision === "ALLOW" ? input.content : null, redactedCount: r.redactedCount, approvalRequestId: r.decision === "REQUIRE_APPROVAL" ? r.eventId : null, incidentId: r.incidentId };
    },

    /** Preview detection + redaction without logging a transmission (no content stored). */
    async testDetection(ctx: TenantContext, raw: unknown) {
      await authorizer.require(ctx, "data_security.read");
      const input = parse(z.object({ content: z.string().min(1).max(200_000), mode: z.enum(REDACTION_MODES).default("mask") }), raw);
      const rules = await loadRules(org(ctx));
      const matches = detect(input.content, { customRules: rules.custom });
      const r = redact(input.content, matches.filter((m) => m.confidence !== "low"), { mode: input.mode, tokenKey: await orgKey(org(ctx)) });
      return { summaries: summarize(matches), redacted: r.text, redactedCount: r.redacted, matches: matches.map((m) => ({ category: m.category, detector: m.detector, label: m.label, confidence: m.confidence, basis: m.basis, method: m.method, start: m.start ?? null, end: m.end ?? null })) };
    },

    /** Shared AI layer policy hook: every platform AI request is evaluated before it reaches a provider. */
    async aiHook(input: Parameters<AIPolicyHook>[0]): Promise<AIPolicyHookResult> {
      if (!(await modules.isEnabled(input.organizationId, MODULE_ID))) return { decision: "ALLOW" };
      const ctx: TenantContext = { organizationId: input.organizationId, actor: input.actor as Actor, correlationId: randomUUID(), cache: new Map() };
      const destName = `platform:${input.model.provider}`;
      const tool = await orgScope(input.organizationId, async (tx) => (await upsertTool(tx, input.organizationId, { vendor: "Platform AI", name: destName, category: "platform", domains: [], source: "platform", status: "approved" })).tool);
      const dest: Destination = { name: destName, trust: tool.status, category: "platform", toolId: tool.id };
      const parts = [input.request.system ?? "", ...input.request.messages.map((m) => m.content)];
      const r = await evaluateDlp(ctx, { parts, destination: dest, source: "ai_gateway", moduleId: input.moduleId, useCase: input.useCase });
      const reasons = [`DLP event ${r.eventId}`, ...r.reasons];
      if (r.decision === "ALLOW") return { decision: "ALLOW" as const, reasons };
      if (r.decision === "REDACT") {
        const [sys, ...msgs] = r.redactedParts!;
        return { decision: "REDACT" as const, reasons, request: { ...(input.request.system !== undefined ? { system: sys } : {}), messages: input.request.messages.map((m, i) => ({ ...m, content: msgs[i]! })) } };
      }
      const [ssys, ...smsgs] = r.sanitizedParts!;
      return { decision: r.decision === "BLOCK" ? "DENY" : "REQUIRE_APPROVAL", reasons, request: { ...(input.request.system !== undefined ? { system: ssys } : {}), messages: input.request.messages.map((m, i) => ({ ...m, content: smsgs[i]! })) } };
    },

    async listDlpEvents(ctx: TenantContext, q: { decision?: string; approval?: string; limit?: number } = {}) {
      await authorizer.require(ctx, "data_security.incident.read");
      return tenant(ctx, async (tx) => {
        const rows = await tx.select().from(dlpEvents).where(and(eq(dlpEvents.organizationId, org(ctx)), q.decision ? eq(dlpEvents.decision, q.decision as DlpDecision) : undefined, q.approval ? eq(dlpEvents.approvalStatus, q.approval as "pending") : undefined)).orderBy(desc(dlpEvents.createdAt)).limit(Math.min(500, q.limit ?? 200));
        return rows.map(dlpView);
      });
    },

    async decideDlpApproval(ctx: TenantContext, id: string, raw: unknown) {
      await authorizer.require(ctx, "data_security.policy.manage");
      if (ctx.actor.type !== "user") throw forbidden("Approvals are decided by people.");
      const input = parse(z.object({ decision: z.enum(["approve", "reject"]), note: text(1000).optional() }), raw);
      uuidOr404(id, "DLP event");
      const e = await tenant(ctx, async (tx) => {
        const [x] = await tx.select().from(dlpEvents).where(and(eq(dlpEvents.organizationId, org(ctx)), eq(dlpEvents.id, id))).limit(1);
        if (!x) throw notFound("DLP event", id);
        if (x.approvalStatus !== "pending") throw conflict(`This request is ${x.approvalStatus ?? "not awaiting approval"}.`);
        if (x.approvalExpiresAt && x.approvalExpiresAt.getTime() <= Date.now()) {
          await tx.update(dlpEvents).set({ approvalStatus: "expired" }).where(eq(dlpEvents.id, id));
          throw conflict("This approval request has expired.");
        }
        if (x.actorId === ctx.actor.id || x.userId === ctx.actor.id) throw forbidden("Separation of duties: you cannot approve your own AI data transfer.");
        const [u] = await tx.update(dlpEvents).set({ approvalStatus: input.decision === "approve" ? "approved" : "rejected", approvalDecidedBy: ctx.actor.id, approvalDecidedAt: new Date(), approvalNote: input.note ?? null, approvalExpiresAt: input.decision === "approve" ? new Date(Date.now() + APPROVAL_VALID_HOURS * 3600_000) : x.approvalExpiresAt }).where(eq(dlpEvents.id, id)).returning();
        return u!;
      });
      await record(ctx, `data_security.dlp_approval_${input.decision === "approve" ? "granted" : "rejected"}`, "dlp_event", id, { metadata: { destination: e.destination, categories: e.categories, note: input.note } });
      if (e.userId) await notifications.notify(ctx, { type: "data_security.dlp_approval", title: `Your AI data transfer to ${e.destination} was ${input.decision === "approve" ? "approved" : "rejected"}`, body: input.decision === "approve" ? `Send the same content again within ${APPROVAL_VALID_HOURS} hours; the approval is single use.` : (input.note ?? ""), actionUrl: `${BASE}/dlp?focus=${id}`, recipients: { userIds: [e.userId] } });
      return dlpView(e);
    },

    // ── Shadow AI ─────────────────────────────────────────────────────────
    async ingestTelemetry(ctx: TenantContext, raw: unknown) {
      await authorizer.require(ctx, "data_security.scan");
      const input = parse(telemetrySchema, raw);
      const key = await orgKey(org(ctx));
      let recorded = 0;
      let skipped = 0;
      const touched = new Set<string>();
      const newTools: ToolRow[] = [];
      for (const ev of input.events) {
        const domain = normalizeDomain(ev.domain ?? ev.url ?? "");
        const cat = domain ? matchCatalog(domain) : null;
        if (!cat && !ev.ai) {
          skipped++;
          continue;
        }
        const res = await tenant(ctx, async (tx) => {
          const { tool, created } = await upsertTool(tx, org(ctx), cat ? { catalogKey: cat.key, vendor: cat.vendor, name: cat.name, category: cat.category, domains: cat.domains, source: "telemetry" } : { vendor: ev.vendor ?? domain ?? "Unknown", name: ev.toolName ?? domain ?? "Unknown AI tool", category: "other", domains: domain ? [domain] : [], source: "telemetry" });
          const member = await memberByEmail(tx, org(ctx), ev.userEmail);
          const ident = ev.userEmail ?? ev.userId;
          const [row] = await tx.insert(shadowAiUsage).values({
            organizationId: org(ctx), toolId: tool.id, telemetrySource: input.source, userId: member?.id ?? null, userFingerprint: member ? null : ident ? hmacSha256(key, ident.toLowerCase()) : null,
            department: ev.department ?? null, domain, eventCount: ev.count, bytesOut: ev.bytesOut ?? null, dataCategories: ev.dataCategories, externalRef: ev.externalRef ?? null, occurredAt: new Date(ev.occurredAt),
          }).onConflictDoNothing().returning({ id: shadowAiUsage.id });
          return { tool, created, inserted: !!row };
        });
        if (res.inserted) recorded++;
        else skipped++;
        touched.add(res.tool.id);
        if (res.created) newTools.push(res.tool);
        // Sensitive categories reported by the telemetry source to a non-approved tool.
        const sens = ev.dataCategories.filter((c) => SENSITIVITY_RANK[sensitivityOf(c)] >= SENSITIVITY_RANK.confidential);
        if (res.inserted && sens.length && res.tool.status !== "approved") {
          const restricted = sens.some((c) => sensitivityOf(c) === "restricted");
          await openOrAppend(ctx, { kind: restricted ? "restricted_data_access" : "unauthorized_ai", severity: restricted ? "high" : "medium", title: `${restricted ? "Restricted" : "Sensitive"} data reported in ${res.tool.name} (${res.tool.status})`, description: `Telemetry source "${input.source}" reported ${sens.join(", ")} sent to ${res.tool.name}.`, source: `telemetry:${input.source}`, dedupeKey: `telemetry:${res.tool.id}`, users: ev.userEmail ? [ev.userEmail] : [], evidence: `${ev.count} event(s) at ${ev.occurredAt} (${sens.join(", ")}).`, toolId: res.tool.id });
        }
      }
      await tenant(ctx, async (tx) => {
        for (const t of touched) await refreshTool(tx, t);
      });
      for (const t of newTools) await announceTool(ctx, t);
      await record(ctx, "data_security.telemetry_ingested", "shadow_ai_usage", org(ctx), { metadata: { source: input.source, recorded, skipped, tools: touched.size, newTools: newTools.length } });
      return { recorded, skipped, tools: touched.size, newTools: newTools.map((t) => ({ id: t.id, name: t.name })) };
    },

    async listTools(ctx: TenantContext, q: { status?: string } = {}) {
      await authorizer.require(ctx, "data_security.shadow_ai.read");
      return tenant(ctx, async (tx) => {
        const rows = await tx.select().from(shadowAiTools).where(and(eq(shadowAiTools.organizationId, org(ctx)), q.status ? eq(shadowAiTools.status, q.status as ToolStatus) : undefined)).orderBy(desc(shadowAiTools.riskScore), shadowAiTools.name);
        const [tele] = await tx.select({ n: sql<number>`count(*)::int`, sources: sql<string[]>`coalesce(array_agg(distinct ${shadowAiUsage.telemetrySource}), '{}')`, last: sql<Date | null>`max(${shadowAiUsage.createdAt})` }).from(shadowAiUsage).where(and(eq(shadowAiUsage.organizationId, org(ctx)), gte(shadowAiUsage.createdAt, new Date(Date.now() - 30 * 86400_000))));
        return { tools: rows.map(toolView), telemetry: { connected: (tele?.n ?? 0) > 0, sources: tele?.sources ?? [], lastEventAt: tele?.last ? new Date(tele.last).toISOString() : null }, catalogSize: AI_TOOL_CATALOG.length };
      });
    },

    async getTool(ctx: TenantContext, id: string) {
      await authorizer.require(ctx, "data_security.shadow_ai.read");
      uuidOr404(id, "AI tool");
      return tenant(ctx, async (tx) => {
        const [t] = await tx.select().from(shadowAiTools).where(and(eq(shadowAiTools.organizationId, org(ctx)), eq(shadowAiTools.id, id))).limit(1);
        if (!t) throw notFound("AI tool", id);
        const byDept = await tx.select({ department: shadowAiUsage.department, events: sql<number>`sum(${shadowAiUsage.eventCount})::int`, users: sql<number>`count(distinct coalesce(${shadowAiUsage.userId}::text, ${shadowAiUsage.userFingerprint}))::int` }).from(shadowAiUsage).where(eq(shadowAiUsage.toolId, id)).groupBy(shadowAiUsage.department);
        const daily = await tx.select({ day: sql<string>`to_char(date_trunc('day', ${shadowAiUsage.occurredAt}), 'YYYY-MM-DD')`, events: sql<number>`sum(${shadowAiUsage.eventCount})::int` }).from(shadowAiUsage).where(and(eq(shadowAiUsage.toolId, id), gte(shadowAiUsage.occurredAt, new Date(Date.now() - 30 * 86400_000)))).groupBy(sql`1`).orderBy(sql`1`);
        const dlp = await tx.select({ decision: dlpEvents.decision, n: sql<number>`count(*)::int` }).from(dlpEvents).where(eq(dlpEvents.toolId, id)).groupBy(dlpEvents.decision);
        return { ...toolView(t), byDepartment: byDept.map((d) => ({ department: d.department ?? "Unknown", events: d.events, users: d.users })), daily, dlp: Object.fromEntries(dlp.map((d) => [d.decision, d.n])) as Record<string, number> };
      });
    },

    async createTool(ctx: TenantContext, raw: unknown) {
      await authorizer.require(ctx, "data_security.policy.manage");
      const input = parse(z.object({ vendor: text(120).min(1), name: text(120).min(1), category: z.enum(TOOL_CATEGORIES).default("other"), domains: z.array(text(253)).max(20).default([]), status: z.enum(TOOL_STATUSES).default("experimental"), notes: text(2000).default("") }), raw);
      const domains = input.domains.map((d) => normalizeDomain(d)).filter((d): d is string => !!d);
      const row = await tenant(ctx, async (tx) => {
        const { tool, created } = await upsertTool(tx, org(ctx), { vendor: input.vendor, name: input.name, category: input.category, domains, source: "manual", status: input.status });
        if (!created) throw conflict(`"${input.vendor} ${input.name}" is already in the inventory.`);
        const [u] = await tx.update(shadowAiTools).set({ notes: input.notes, statusChangedBy: userId(ctx), statusChangedAt: new Date() }).where(eq(shadowAiTools.id, tool.id)).returning();
        await refreshTool(tx, tool.id);
        return u!;
      });
      await record(ctx, "data_security.ai_tool_added", "shadow_ai_tool", row.id, { after: { vendor: input.vendor, name: input.name, status: input.status } });
      return toolView(row);
    },

    async setToolStatus(ctx: TenantContext, id: string, raw: unknown) {
      await authorizer.require(ctx, "data_security.policy.manage");
      const input = parse(z.object({ status: z.enum(TOOL_STATUSES), notes: text(2000).optional() }), raw);
      uuidOr404(id, "AI tool");
      const res = await tenant(ctx, async (tx) => {
        const [t] = await tx.select().from(shadowAiTools).where(and(eq(shadowAiTools.organizationId, org(ctx)), eq(shadowAiTools.id, id))).limit(1);
        if (!t) throw notFound("AI tool", id);
        await tx.update(shadowAiTools).set({ status: input.status, ...(input.notes !== undefined ? { notes: input.notes } : {}), statusChangedBy: userId(ctx), statusChangedAt: new Date() }).where(eq(shadowAiTools.id, id));
        await refreshTool(tx, id);
        if (input.status === "blocked") await tx.update(remediationActions).set({ status: "completed", completedBy: userId(ctx), completedAt: new Date(), result: "Destination blocked." }).where(and(eq(remediationActions.toolId, id), eq(remediationActions.action, "block_ai_destination"), eq(remediationActions.status, "recommended")));
        const [u] = await tx.select().from(shadowAiTools).where(eq(shadowAiTools.id, id)).limit(1);
        return { before: t, after: u! };
      });
      await record(ctx, "data_security.ai_tool_status_changed", "shadow_ai_tool", id, { before: { status: res.before.status }, after: { status: input.status }, metadata: { notes: input.notes } });
      return toolView(res.after);
    },

    // ── Incidents ─────────────────────────────────────────────────────────
    async listIncidents(ctx: TenantContext, q: { status?: string; severity?: string; kind?: string } = {}) {
      await authorizer.require(ctx, "data_security.incident.read");
      return tenant(ctx, async (tx) => {
        const rows = await tx.select({ i: securityIncidents, ownerName: users.name }).from(securityIncidents).leftJoin(users, eq(users.id, securityIncidents.ownerUserId))
          .where(and(eq(securityIncidents.organizationId, org(ctx)), q.status === "active" ? ne(securityIncidents.status, "resolved") : q.status ? eq(securityIncidents.status, q.status as "open") : undefined, q.severity ? eq(securityIncidents.severity, q.severity as Severity) : undefined, q.kind ? eq(securityIncidents.kind, q.kind as IncidentKind) : undefined))
          .orderBy(desc(sql`case ${securityIncidents.status} when 'resolved' then 0 else 1 end`), desc(sql`case ${securityIncidents.severity} when 'critical' then 3 when 'high' then 2 when 'medium' then 1 else 0 end`), desc(securityIncidents.updatedAt)).limit(1000);
        return rows.map(({ i, ownerName }) => incidentView(i, ownerName));
      });
    },

    async getIncident(ctx: TenantContext, id: string) {
      await authorizer.require(ctx, "data_security.incident.read");
      uuidOr404(id, "Incident");
      return tenant(ctx, async (tx) => {
        const [row] = await tx.select({ i: securityIncidents, ownerName: users.name }).from(securityIncidents).leftJoin(users, eq(users.id, securityIncidents.ownerUserId)).where(and(eq(securityIncidents.organizationId, org(ctx)), eq(securityIncidents.id, id))).limit(1);
        if (!row) throw notFound("Incident", id);
        const timeline = await tx.select().from(incidentEvents).where(eq(incidentEvents.incidentId, id)).orderBy(incidentEvents.createdAt);
        const assets = row.i.affectedAssetIds.length ? await tx.select({ id: dataAssets.id, name: dataAssets.name, classification: dataAssets.classification }).from(dataAssets).where(inArray(dataAssets.id, row.i.affectedAssetIds)) : [];
        const rem = await tx.select().from(remediationActions).where(eq(remediationActions.incidentId, id)).orderBy(remediationActions.createdAt);
        const dlp = await tx.select().from(dlpEvents).where(eq(dlpEvents.incidentId, id)).orderBy(desc(dlpEvents.createdAt)).limit(50);
        return {
          ...incidentView(row.i, row.ownerName),
          timeline: timeline.map((t) => ({ id: t.id, kind: t.kind, message: t.message, data: t.data, actor: t.actorLabel, at: t.createdAt.toISOString() })),
          assets, remediation: rem.map(remediationView), dlpEvents: dlp.map(dlpView),
        };
      });
    },

    async createIncident(ctx: TenantContext, raw: unknown) {
      await authorizer.require(ctx, "data_security.incident.manage");
      const input = parse(z.object({ kind: z.enum(INCIDENT_KINDS).default("manual"), severity: z.enum(["low", "medium", "high", "critical"]), title: text(200).min(3), description: text(4000).default(""), assetIds: z.array(z.string().uuid()).max(50).default([]), affectedUsers: z.array(text(320)).max(50).default([]) }), raw);
      const valid = input.assetIds.length ? await tenant(ctx, (tx) => tx.select({ id: dataAssets.id }).from(dataAssets).where(and(eq(dataAssets.organizationId, org(ctx)), inArray(dataAssets.id, input.assetIds)))) : [];
      const i = await openOrAppend(ctx, { kind: input.kind, severity: input.severity, title: input.title, description: input.description, source: "manual", dedupeKey: `manual:${randomUUID()}`, assetIds: valid.map((v) => v.id), users: input.affectedUsers, evidence: `Opened by ${ctx.actor.label}.` });
      return { id: i.id };
    },

    async updateIncident(ctx: TenantContext, id: string, raw: unknown) {
      await authorizer.require(ctx, "data_security.incident.manage");
      const input = parse(z.object({
        status: z.enum(["open", "investigating", "contained", "resolved"]).optional(), severity: z.enum(["low", "medium", "high", "critical"]).optional(), ownerUserId: z.string().uuid().nullable().optional(),
        rootCause: text(4000).optional(), resolution: text(4000).optional(), remediation: text(4000).optional(), note: text(4000).optional(),
      }), raw);
      uuidOr404(id, "Incident");
      const res = await tenant(ctx, async (tx) => {
        const [i] = await tx.select().from(securityIncidents).where(and(eq(securityIncidents.organizationId, org(ctx)), eq(securityIncidents.id, id))).limit(1);
        if (!i) throw notFound("Incident", id);
        if (input.status === "resolved" && !(input.resolution ?? i.resolution)) throw new AppError("VALIDATION_FAILED", "Record a resolution before resolving the incident.");
        if (input.ownerUserId) {
          const ok = await tx.execute(sql`select 1 from memberships where organization_id = ${org(ctx)} and user_id = ${input.ownerUserId} and status = 'active' limit 1`);
          if (!ok.rows.length) throw new AppError("VALIDATION_FAILED", "The owner must be an active member of this organization.");
        }
        const set: Partial<IncidentRow> = { updatedAt: new Date() };
        const events: Array<{ kind: "status_change" | "assignment" | "severity_change" | "note" | "remediation"; message: string }> = [];
        if (input.status && input.status !== i.status) {
          set.status = input.status;
          events.push({ kind: "status_change", message: `Status ${i.status} → ${input.status}` });
          if (input.status === "resolved") Object.assign(set, { resolvedBy: userId(ctx), resolvedAt: new Date() });
          else if (i.status === "resolved") Object.assign(set, { resolvedBy: null, resolvedAt: null });
        }
        if (input.severity && input.severity !== i.severity) {
          set.severity = input.severity;
          events.push({ kind: "severity_change", message: `Severity ${i.severity} → ${input.severity}` });
        }
        if (input.ownerUserId !== undefined && input.ownerUserId !== i.ownerUserId) {
          set.ownerUserId = input.ownerUserId;
          events.push({ kind: "assignment", message: input.ownerUserId ? "Owner assigned" : "Owner cleared" });
        }
        if (input.rootCause !== undefined) {
          set.rootCause = input.rootCause;
          events.push({ kind: "note", message: `Root cause: ${input.rootCause.slice(0, 300)}` });
        }
        if (input.resolution !== undefined) set.resolution = input.resolution;
        if (input.remediation !== undefined) {
          set.remediation = input.remediation;
          events.push({ kind: "remediation", message: input.remediation.slice(0, 300) });
        }
        if (input.note) events.push({ kind: "note", message: input.note });
        const [u] = await tx.update(securityIncidents).set(set).where(eq(securityIncidents.id, id)).returning();
        for (const e of events) await tx.insert(incidentEvents).values({ organizationId: org(ctx), incidentId: id, kind: e.kind, message: e.message, actorLabel: ctx.actor.label });
        return { before: i, after: u! };
      });
      await record(ctx, "data_security.incident_updated", "security_incident", id, { before: { status: res.before.status, severity: res.before.severity, ownerUserId: res.before.ownerUserId }, after: { status: res.after.status, severity: res.after.severity, ownerUserId: res.after.ownerUserId }, metadata: { note: input.note } });
      if (input.ownerUserId && input.ownerUserId !== res.before.ownerUserId) await notifications.notify(ctx, { type: "data_security.incident", title: `You own security incident: ${res.after.title}`, body: res.after.description.slice(0, 300), actionUrl: `${BASE}/incidents/${id}`, recipients: { userIds: [input.ownerUserId] } });
      return incidentView(res.after);
    },

    // ── Remediation ───────────────────────────────────────────────────────
    async listRemediation(ctx: TenantContext, q: { status?: string } = {}) {
      await authorizer.require(ctx, "data_security.read");
      return tenant(ctx, async (tx) => {
        const rows = await tx.select({ r: remediationActions, assetName: dataAssets.name, toolName: shadowAiTools.name }).from(remediationActions).leftJoin(dataAssets, eq(dataAssets.id, remediationActions.assetId)).leftJoin(shadowAiTools, eq(shadowAiTools.id, remediationActions.toolId))
          .where(and(eq(remediationActions.organizationId, org(ctx)), q.status ? eq(remediationActions.status, q.status as "recommended") : undefined)).orderBy(desc(remediationActions.createdAt)).limit(1000);
        return rows.map(({ r, assetName, toolName }) => ({ ...remediationView(r), assetName, toolName }));
      });
    },

    /**
     * Complete a remediation. Platform-internal actions are applied here
     * (owner, classification, AI destination status). Permission changes in
     * source systems are never made automatically: they are performed there
     * and attested here, and the next scan verifies them.
     */
    async completeRemediation(ctx: TenantContext, id: string, raw: unknown) {
      await authorizer.require(ctx, "data_security.remediation.manage");
      const input = parse(z.object({ note: text(2000).optional(), ownerUserId: z.string().uuid().optional(), classification: sensitivityEnum.optional() }), raw);
      uuidOr404(id, "Remediation");
      const [r] = await tenant(ctx, (tx) => tx.select().from(remediationActions).where(and(eq(remediationActions.organizationId, org(ctx)), eq(remediationActions.id, id))).limit(1));
      if (!r) throw notFound("Remediation", id);
      if (r.status !== "recommended") throw conflict(`This remediation is already ${r.status}.`);
      let result: string;
      switch (r.action) {
        case "assign_owner": {
          if (!input.ownerUserId || !r.assetId) throw new AppError("VALIDATION_FAILED", "ownerUserId is required.");
          await tenant(ctx, async (tx) => {
            const ok = await tx.execute(sql`select 1 from memberships where organization_id = ${org(ctx)} and user_id = ${input.ownerUserId} and status = 'active' limit 1`);
            if (!ok.rows.length) throw new AppError("VALIDATION_FAILED", "The owner must be an active member of this organization.");
            const [u] = await tx.update(dataAssets).set({ ownerUserId: input.ownerUserId, ownerLabel: null, currentVersion: sql`${dataAssets.currentVersion} + 1`, updatedAt: new Date() }).where(eq(dataAssets.id, r.assetId!)).returning();
            await tx.insert(dataAssetVersions).values({ organizationId: org(ctx), assetId: r.assetId!, version: u!.currentVersion, snapshot: snapshotOf(u!), changeNote: "Owner assigned (remediation)", createdBy: userId(ctx) });
            await tx.update(accessFindings).set({ status: "resolved", resolvedAt: new Date(), resolutionNote: "Owner assigned." }).where(and(eq(accessFindings.assetId, r.assetId!), eq(accessFindings.kind, "no_owner"), eq(accessFindings.status, "open")));
          });
          result = "Owner assigned.";
          break;
        }
        case "change_classification": {
          if (!input.classification || !r.assetId) throw new AppError("VALIDATION_FAILED", "classification is required.");
          await service.setAssetClassification(ctx, r.assetId, { classification: input.classification, lock: true, note: "Remediation" });
          result = `Classification set to ${input.classification}.`;
          break;
        }
        case "block_ai_destination":
        case "require_approval": {
          if (!r.toolId) throw new AppError("VALIDATION_FAILED", "This remediation has no AI destination.");
          await service.setToolStatus(ctx, r.toolId, { status: r.action === "block_ai_destination" ? "blocked" : "restricted" });
          result = r.action === "block_ai_destination" ? "Destination blocked: DLP now blocks all content to it." : "Destination restricted: sensitive content to it needs approval.";
          break;
        }
        default: {
          if (!input.note || input.note.length < 5) throw new AppError("VALIDATION_FAILED", "Describe what was done in the source system (note, at least 5 characters). The platform does not change source-system permissions.");
          result = `Attested: ${input.note}. The next scan verifies it.`;
        }
      }
      const [u] = await tenant(ctx, (tx) => tx.update(remediationActions).set({ status: "completed", completedBy: userId(ctx), completedAt: new Date(), result }).where(and(eq(remediationActions.id, id), eq(remediationActions.status, "recommended"))).returning());
      if (r.incidentId) await tenant(ctx, (tx) => tx.insert(incidentEvents).values({ organizationId: org(ctx), incidentId: r.incidentId!, kind: "remediation", message: `${r.title}: ${result}`, actorLabel: ctx.actor.label }));
      await record(ctx, "data_security.remediation_completed", "remediation_action", id, { metadata: { action: r.action, execution: r.execution, result } });
      return u ? remediationView(u) : remediationView({ ...r, status: "completed", result });
    },

    async dismissRemediation(ctx: TenantContext, id: string, raw: unknown) {
      await authorizer.require(ctx, "data_security.remediation.manage");
      const input = parse(z.object({ note: text(2000).min(3) }), raw);
      uuidOr404(id, "Remediation");
      const [u] = await tenant(ctx, (tx) => tx.update(remediationActions).set({ status: "dismissed", completedBy: userId(ctx), completedAt: new Date(), result: `Dismissed: ${input.note}` }).where(and(eq(remediationActions.organizationId, org(ctx)), eq(remediationActions.id, id), eq(remediationActions.status, "recommended"))).returning());
      if (!u) throw notFound("Open remediation", id);
      await record(ctx, "data_security.remediation_dismissed", "remediation_action", id, { metadata: { action: u.action, note: input.note } });
      return remediationView(u);
    },

    // ── Dashboard ─────────────────────────────────────────────────────────
    async dashboard(ctx: TenantContext): Promise<DashboardView> {
      await authorizer.require(ctx, "data_security.read");
      return tenant(ctx, async (tx) => {
        const o = org(ctx);
        const since = new Date(Date.now() - 30 * 86400_000);
        const [a] = await tx.select({ total: sql<number>`count(*)::int`, sensitive: sql<number>`count(*) filter (where ${dataAssets.classification} in ('confidential','restricted'))::int`, exposed: sql<number>`count(*) filter (where ${dataAssets.classification} in ('confidential','restricted') and ${dataAssets.aiExposureStatus} <> 'none')::int` }).from(dataAssets).where(eq(dataAssets.organizationId, o));
        const [t] = await tx.select({ total: sql<number>`count(*) filter (where ${shadowAiTools.source} <> 'platform')::int`, unapproved: sql<number>`count(*) filter (where ${shadowAiTools.status} <> 'approved')::int` }).from(shadowAiTools).where(eq(shadowAiTools.organizationId, o));
        const dlp = await tx.select({ decision: dlpEvents.decision, n: sql<number>`count(*)::int` }).from(dlpEvents).where(and(eq(dlpEvents.organizationId, o), gte(dlpEvents.createdAt, since))).groupBy(dlpEvents.decision);
        const [pa] = await tx.select({ n: sql<number>`count(*)::int` }).from(dlpEvents).where(and(eq(dlpEvents.organizationId, o), eq(dlpEvents.approvalStatus, "pending")));
        const [inc] = await tx.select({ open: sql<number>`count(*) filter (where ${securityIncidents.status} <> 'resolved')::int`, critical: sql<number>`count(*) filter (where ${securityIncidents.status} <> 'resolved' and ${securityIncidents.severity} = 'critical')::int` }).from(securityIncidents).where(eq(securityIncidents.organizationId, o));
        const risks = await tx.select({ severity: accessFindings.severity, n: sql<number>`count(*)::int` }).from(accessFindings).where(and(eq(accessFindings.organizationId, o), eq(accessFindings.status, "open"))).groupBy(accessFindings.severity);
        const rem = await tx.select({ status: remediationActions.status, n: sql<number>`count(*)::int` }).from(remediationActions).where(eq(remediationActions.organizationId, o)).groupBy(remediationActions.status);
        const [tele] = await tx.select({ n: sql<number>`count(*)::int` }).from(shadowAiUsage).where(and(eq(shadowAiUsage.organizationId, o), gte(shadowAiUsage.createdAt, since)));
        const [scan] = await tx.select({ at: dataScans.finishedAt }).from(dataScans).where(and(eq(dataScans.organizationId, o), eq(dataScans.status, "succeeded"))).orderBy(desc(dataScans.finishedAt)).limit(1);
        const cats = await tx.select({ c: sql<string>`c`, n: sql<number>`count(*)::int` }).from(sql`${dataAssets}, unnest(${dataAssets.categories}) c`).where(eq(dataAssets.organizationId, o)).groupBy(sql`c`).orderBy(desc(sql`2`));
        const top = await tx.select({ f: accessFindings, assetName: dataAssets.name }).from(accessFindings).innerJoin(dataAssets, eq(dataAssets.id, accessFindings.assetId)).where(and(eq(accessFindings.organizationId, o), eq(accessFindings.status, "open")))
          .orderBy(desc(sql`case ${accessFindings.severity} when 'critical' then 3 when 'high' then 2 when 'medium' then 1 else 0 end`), desc(accessFindings.lastSeenAt)).limit(8);
        const rc = Object.fromEntries(rem.map((r) => [r.status, r.n])) as Record<string, number>;
        const completed = rc.completed ?? 0;
        const open = rc.recommended ?? 0;
        const dc = Object.fromEntries(dlp.map((d) => [d.decision, d.n])) as Record<string, number>;
        return {
          sensitiveAssets: a?.sensitive ?? 0, exposedSensitiveAssets: a?.exposed ?? 0, totalAssets: a?.total ?? 0, shadowAiTools: t?.total ?? 0, unapprovedAiTools: t?.unapproved ?? 0,
          blockedTransmissions30d: dc.BLOCK ?? 0, redactedTransmissions30d: dc.REDACT ?? 0, pendingApprovals: pa?.n ?? 0, openIncidents: inc?.open ?? 0, criticalIncidents: inc?.critical ?? 0,
          permissionRisks: { low: 0, medium: 0, high: 0, critical: 0, ...Object.fromEntries(risks.map((r) => [r.severity, r.n])) } as Record<Severity, number>,
          remediation: { completed, open, dismissed: rc.dismissed ?? 0, percent: completed + open ? Math.round((completed / (completed + open)) * 100) : 0 },
          telemetryConnected: (tele?.n ?? 0) > 0, lastScanAt: iso(scan?.at ?? null),
          byCategory: cats.map((c) => ({ label: (CATEGORY_META as Record<string, { label: string }>)[c.c]?.label ?? c.c, value: c.n })),
          dlp30d: DLP_DECISIONS.map((d) => ({ label: d.replace("_", " ").toLowerCase(), value: dc[d] ?? 0 })),
          topFindings: top.map(({ f, assetName }) => ({ id: f.id, assetId: f.assetId, assetName, kind: f.kind, severity: f.severity, detail: f.detail })),
        };
      });
    },

    // ── Internal (wired in index.ts) ──────────────────────────────────────
    /** Daily purge: DLP events and usage older than each organization's AI-run retention. */
    async applyRetention() {
      await db.withSystem("data_security.retention", async (tx) => {
        await tx.execute(sql`delete from dlp_events e using organization_settings s where s.organization_id = e.organization_id and e.created_at < now() - make_interval(days => coalesce((s.data_retention->>'aiRunDays')::int, 365)) and e.approval_status is distinct from 'pending'`);
        await tx.execute(sql`delete from shadow_ai_usage u using organization_settings s where s.organization_id = u.organization_id and u.occurred_at < now() - make_interval(days => coalesce((s.data_retention->>'aiRunDays')::int, 365))`);
        await tx.execute(sql`update dlp_events set approval_status = 'expired' where approval_status in ('pending','approved') and approval_expires_at < now()`);
      });
    },
  };

  async function announceTool(ctx: TenantContext, t: ToolRow) {
    await bus.publish(ctx, "data_security.shadow_ai.discovered", { toolId: t.id, vendor: t.vendor, name: t.name, status: t.status });
    await notifications.notify(ctx, { type: "data_security.shadow_ai_discovered", title: `New AI tool seen: ${t.vendor} ${t.name}`, body: "Review it and set it to approved, experimental, restricted or blocked.", actionUrl: `${BASE}/shadow-ai/${t.id}`, recipients: { permission: "data_security.policy.manage" } });
  }

  async function recompute(ctx: TenantContext, assetId: string, note: string) {
    const rules = await loadRules(org(ctx));
    await tenant(ctx, async (tx) => {
      const [a] = await tx.select().from(dataAssets).where(eq(dataAssets.id, assetId)).limit(1);
      if (!a) return;
      const cls = await tx.select().from(dataClassifications).where(and(eq(dataClassifications.assetId, assetId), ne(dataClassifications.reviewStatus, "rejected")));
      const eff = cls.map((c) => ({ category: c.category, count: c.matchCount, confidence: c.reviewStatus === "confirmed" ? ("high" as const) : c.confidence, methods: [], detectors: [], basis: [], redactable: 0 } as CategorySummary));
      const classification = a.classificationLocked ? a.classification : overallSensitivity(eff, rules.custom);
      const categories = eff.filter((c) => c.confidence !== "low").map((c) => c.category).sort();
      if (classification === a.classification && categories.join() === a.categories.join()) return;
      const [u] = await tx.update(dataAssets).set({ classification, categories, currentVersion: sql`${dataAssets.currentVersion} + 1`, updatedAt: new Date() }).where(eq(dataAssets.id, assetId)).returning();
      await tx.insert(dataAssetVersions).values({ organizationId: org(ctx), assetId, version: u!.currentVersion, snapshot: snapshotOf(u!), changeNote: note, createdBy: userId(ctx) });
    });
  }

  return service;
}
