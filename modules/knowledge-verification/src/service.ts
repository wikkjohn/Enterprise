import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type AIService } from "@eaop/ai";
import { type AuditService } from "@eaop/audit";
import { type ConnectorService } from "@eaop/connectors";
import { and, desc, eq, gte, inArray, memberships, ne, or, scopeOf, sql, users, type Database, type Tx } from "@eaop/db";
import { type EventBus } from "@eaop/events";
import { type JobQueue } from "@eaop/jobs";
import { type ModuleService } from "@eaop/module-registry";
import { type NotificationService } from "@eaop/notifications";
import { redactString, type Logger } from "@eaop/observability";
import { type OrganizationService } from "@eaop/organizations";
import { type Authorizer } from "@eaop/rbac";
import { AppError, conflict, forbidden, isAppError, isUuid, notFound, SYSTEM_ACTOR, type TenantContext } from "@eaop/shared-types";
import { type UsageService } from "@eaop/usage";
import { compare, type DocForComparison } from "./conflicts";
import { extract, formatFromName, FORMATS, type DocFormat } from "./extract";
import { pgTextArray, postgresFtsProvider, toTsQuery, type KnowledgeIndexProvider } from "./indexing";
import { categorize, DEFAULT_CATEGORIES, freshnessOf, normalizeQuestion, rank, type EscalationCategory, type Freshness } from "./rank";
import {
  knowledgeAnswers, knowledgeChunks, knowledgeCitations, knowledgeClaims, knowledgeConflicts, knowledgeDocuments, knowledgeDocumentVersions, knowledgeIndexes, knowledgePermissions,
  knowledgeQueries, knowledgeReviews, knowledgeSettings, knowledgeSources, knowledgeVerifications, type AclEntry, type Classification, type ReviewKind,
} from "./schema";
import { chunk, minhash, sha256, terms, words } from "./text";
import { assessConfidence, AUTHORITIES, extractClaims, extractiveAnswer, verifyClaim, type Authority, type SourcePassage } from "./verify";

export const MODULE_ID = "knowledge_verification" as const;
export const SYNC_JOB = "knowledge_verification.sync";
export const FRESHNESS_JOB = "knowledge_verification.freshness";
export const RETENTION_JOB = "knowledge_verification.retention";
const BASE = "/m/knowledge-verification";
const CONTEXT_PASSAGES = 6;

function parse<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.output<S> {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  throw new AppError("VALIDATION_FAILED", r.error.issues[0] ? `${r.error.issues[0].path.join(".") || "input"}: ${r.error.issues[0].message}` : "Request validation failed.", {
    issues: r.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })),
  });
}

// ── Input schemas ───────────────────────────────────────────────────────────

const text = (max: number) => z.string().trim().max(max);
const classificationEnum = z.enum(["public", "internal", "confidential", "restricted"]);
const dateish = z.coerce.date();
const PRINCIPAL_RE = /^(org:\*|user:[0-9a-f-]{36}|role:[a-z0-9_.-]{1,60}|dept:[a-z0-9 _.-]{1,80}|api_key:[0-9a-f-]{36}|agent:[0-9a-f-]{36})$/;

const aclEntrySchema = z.object({ type: z.enum(["user", "group", "role", "department", "domain", "link", "organization"]), id: text(300).optional(), name: text(300).optional(), email: z.string().trim().toLowerCase().max(320).optional() });
export const permissionsInputSchema = z.object({ scope: z.enum(["private", "specific", "group", "organization", "public"]).optional(), principals: z.array(aclEntrySchema).max(500).default([]) });

export const sourceInputSchema = z.object({
  name: text(160).min(1),
  kind: z.enum(["upload", "connector", "api"]).default("upload"),
  connectorId: z.string().uuid().nullish(),
  path: text(500).optional(),
  authority: z.enum(AUTHORITIES).default("secondary"),
  ownerUserId: z.string().uuid().nullish(),
  department: text(120).nullish(),
  classification: classificationEnum.default("internal"),
  defaultPrincipals: z.array(z.string().regex(PRINCIPAL_RE, "Principals look like org:*, user:<id>, role:<key> or dept:<name>")).max(200).default(["org:*"]),
  staleDays: z.number().int().min(7).max(3650).nullish(),
});

export const documentInputSchema = z.object({
  sourceId: z.string().uuid(),
  externalId: text(500).optional(),
  /** Optional for file uploads: defaults to the title embedded in the file, then the file name. */
  title: text(500).min(1).optional(),
  filename: text(300).optional(),
  format: z.enum(FORMATS).optional(),
  mimeType: text(200).optional(),
  text: z.string().max(5_000_000).optional(),
  contentBase64: z.string().max(28_000_000).optional(),
  record: z.unknown().optional(),
  sourceUrl: z.string().url().max(2000).optional(),
  owner: z.string().trim().toLowerCase().max(320).nullish(),
  department: text(120).nullish(),
  classification: classificationEnum.optional(),
  authority: z.enum(AUTHORITIES).nullish(),
  effectiveDate: dateish.nullish(),
  expirationDate: dateish.nullish(),
  reviewDueAt: dateish.nullish(),
  lastModifiedAt: dateish.nullish(),
  permissions: permissionsInputSchema.optional(),
}).refine((d) => d.text !== undefined || d.contentBase64 !== undefined || d.record !== undefined, "Provide text, contentBase64 or record.")
  .refine((d) => !!d.title || !!d.filename, "Provide a title or a filename.");

export const askSchema = z.object({
  question: z.string().trim().min(3).max(2000),
  /** For module-to-module calls made with a system context: whose permissions apply. */
  onBehalfOfUserId: z.string().uuid().optional(),
  sourceModule: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/).optional(),
});

export const settingsSchema = z.object({
  staleDays: z.number().int().min(7).max(3650).optional(),
  reviewIntervalDays: z.number().int().min(7).max(3650).optional(),
  storeQuestions: z.boolean().optional(),
  escalationCategories: z.array(z.object({
    key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), label: text(80).min(1), keywords: z.array(text(80).min(2)).min(1).max(100),
    escalateWhen: z.enum(["low_confidence", "always"]).default("low_confidence"), expertUserIds: z.array(z.string().uuid()).max(50).default([]),
  })).max(30).nullable().optional(),
});

// ── Views ───────────────────────────────────────────────────────────────────

type SourceRow = typeof knowledgeSources.$inferSelect;
type DocRow = typeof knowledgeDocuments.$inferSelect;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export const sourceView = (s: SourceRow) => ({
  id: s.id, name: s.name, kind: s.kind, connectorId: s.connectorId, path: (s.config as { path?: string }).path ?? null, authority: s.authority, ownerUserId: s.ownerUserId, department: s.department,
  classification: s.classification, defaultPrincipals: s.defaultPrincipals, staleDays: s.staleDays, status: s.status, lastSyncAt: iso(s.lastSyncAt), lastSyncStatus: s.lastSyncStatus,
  lastSyncMessage: s.lastSyncMessage, createdAt: s.createdAt.toISOString(),
});
export type SourceView = ReturnType<typeof sourceView>;

export const documentView = (d: DocRow, extra: { sourceName?: string; sourceAuthority?: Authority; ownerName?: string | null; freshness?: Freshness } = {}) => ({
  id: d.id, sourceId: d.sourceId, sourceName: extra.sourceName ?? null, externalId: d.externalId, title: d.title, format: d.format, sourceUrl: d.sourceUrl, ownerUserId: d.ownerUserId,
  owner: extra.ownerName ?? d.ownerLabel, department: d.department, classification: d.classification, authority: d.authority ?? extra.sourceAuthority ?? "secondary", authorityInherited: d.authority === null,
  status: d.status, ingestionStatus: d.ingestionStatus, ingestionError: d.ingestionError, ingestionWarnings: d.ingestionWarnings, version: d.currentVersion, charCount: d.charCount,
  chunkCount: d.chunkCount, effectiveDate: iso(d.effectiveDate), expirationDate: iso(d.expirationDate), reviewDueAt: iso(d.reviewDueAt), lastReviewedAt: iso(d.lastReviewedAt),
  lastModifiedAt: iso(d.lastModifiedAt), supersededByDocumentId: d.supersededByDocumentId, freshness: extra.freshness ?? null, createdAt: d.createdAt.toISOString(), updatedAt: d.updatedAt.toISOString(),
});
export type DocumentView = ReturnType<typeof documentView>;

export interface CitationView { marker: string; documentId: string | null; title: string; sourceName: string | null; authority: Authority; freshness: string; documentDate: string | null; version: number; excerpt: string | null; cited: boolean; score: number }
export interface ClaimView { text: string | null; important: boolean; cited: string[]; status: string; explanation: string; supporting: string[]; contradicting: string[] }
export interface AnswerView {
  queryId: string;
  answerId: string;
  question: string | null;
  response: string | null;
  /** Set when the viewer may not see the answer text (it used documents they cannot access). */
  hiddenReason?: string | null;
  mode: "generative" | "extractive" | "none";
  modeNote: string | null;
  confidence: { level: string; summary: string; factors: Array<{ factor: string; label: string; value: string; effect: string; detail: string }> };
  uncertainty: string | null;
  citations: CitationView[];
  claims: ClaimView[];
  escalation: { categories: string[]; reviewId: string | null } | null;
  verificationFailed: boolean;
  createdAt: string;
  askedBy: string;
}

export interface RetrievedPassage { marker: string; chunkId: string; documentId: string; title: string; sourceName: string; text: string; heading: string | null; authority: Authority; freshness: "fresh" | "stale"; documentDate: string | null; version: number; classification: Classification; score: number }

export interface KnowledgeDeps {
  db: Database;
  authorizer: Authorizer;
  audit: AuditService;
  bus: EventBus;
  notifications: NotificationService;
  ai: AIService;
  connectors: ConnectorService;
  jobs: JobQueue;
  organizations: OrganizationService;
  usage: UsageService;
  modules: Pick<ModuleService, "requireEnabled" | "isEnabled">;
  logger: Logger;
}

export type KnowledgeService = ReturnType<typeof createKnowledgeService>;

/**
 * The stable, permission-aware API other modules use (via
 * `platform.moduleServices.get("knowledge_verification")`). Callers pass their
 * own context; with a system context they must say on whose behalf they ask,
 * otherwise only organization-wide documents are visible.
 */
export type KnowledgeApi = Pick<KnowledgeService, "retrieve" | "ask" | "documentMetadata">;

const ANSWER_SYSTEM = [
  "You answer employees' questions using ONLY the numbered sources provided.",
  "Rules: cite every factual sentence with its source marker, e.g. [S1]. Never use outside knowledge. Never invent figures, names or dates.",
  "If the sources do not answer the question, say so plainly in one sentence. If sources disagree, say that they disagree and cite each.",
  "Prefer authoritative and current sources. Be concise: at most five sentences.",
].join("\n");

export function createKnowledgeService(deps: KnowledgeDeps) {
  const { db, authorizer, audit, bus, notifications, ai, connectors, jobs, organizations, usage, modules, logger } = deps;
  const tenant = <T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>) => db.withTenant(scopeOf(ctx), fn);
  const orgScope = <T>(orgId: string, fn: (tx: Tx) => Promise<T>) => db.withTenant({ organizationId: orgId }, fn);
  const org = (ctx: TenantContext) => ctx.organizationId;
  const userId = (ctx: TenantContext) => (ctx.actor.type === "user" ? ctx.actor.id : null);
  const record = (ctx: TenantContext, action: string, resourceType: string, resourceId: string, extra: { before?: unknown; after?: unknown; metadata?: Record<string, unknown>; outcome?: "success" | "failure" | "denied" } = {}) =>
    audit.record(ctx, { module: MODULE_ID, action, resourceType, resourceId, ...extra });
  const sysCtx = (orgId: string): TenantContext => ({ organizationId: orgId, actor: SYSTEM_ACTOR("knowledge_verification"), correlationId: randomUUID(), cache: new Map() });
  const uuidOr404 = (id: string, what: string) => {
    if (!isUuid(id)) throw notFound(what, id);
  };

  const providers = new Map<string, KnowledgeIndexProvider>([[postgresFtsProvider.key, postgresFtsProvider]]);

  // ── Settings & index registry ───────────────────────────────────────────
  async function settings(orgId: string) {
    return orgScope(orgId, async (tx) => {
      const [s] = await tx.select().from(knowledgeSettings).where(eq(knowledgeSettings.organizationId, orgId)).limit(1);
      if (s) return s;
      await tx.insert(knowledgeSettings).values({ organizationId: orgId }).onConflictDoNothing();
      return (await tx.select().from(knowledgeSettings).where(eq(knowledgeSettings.organizationId, orgId)).limit(1))[0]!;
    });
  }
  const categoriesOf = (s: { escalationCategories: EscalationCategory[] | null }) => s.escalationCategories ?? DEFAULT_CATEGORIES;

  async function indexFor(orgId: string): Promise<KnowledgeIndexProvider> {
    const [row] = await orgScope(orgId, async (tx) => {
      const [x] = await tx.select().from(knowledgeIndexes).where(and(eq(knowledgeIndexes.organizationId, orgId), eq(knowledgeIndexes.isDefault, true))).limit(1);
      if (x) return [x];
      return tx.insert(knowledgeIndexes).values({ organizationId: orgId, name: "default", provider: postgresFtsProvider.key, isDefault: true, status: "ready" }).onConflictDoNothing().returning();
    });
    return providers.get(row?.provider ?? postgresFtsProvider.key) ?? postgresFtsProvider;
  }
  async function refreshIndexStats(orgId: string) {
    await orgScope(orgId, (tx) => tx.execute(sql`update knowledge_indexes set document_count = (select count(*) from knowledge_documents where organization_id = ${orgId} and status = 'active' and ingestion_status = 'indexed'), chunk_count = (select count(*) from knowledge_chunks c join knowledge_documents d on d.id = c.document_id and c.version = d.current_version where c.organization_id = ${orgId} and d.status = 'active'), last_built_at = now() where organization_id = ${orgId} and is_default`));
  }

  // ── Identity → principals ───────────────────────────────────────────────
  const deptPrincipal = (d: string) => `dept:${d.toLowerCase().replace(/[^a-z0-9 _.-]/g, "").trim().slice(0, 80)}`;

  /** Principals of a platform user in this organization; empty (sees nothing) when not an active member. */
  async function userPrincipals(orgId: string, uid: string): Promise<{ principals: string[]; department: string | null }> {
    const rows = await orgScope(orgId, (tx) => tx.execute(sql`
      select m.department, r.key from memberships m
      join users u on u.id = m.user_id and u.status = 'active'
      left join member_roles mr on mr.membership_id = m.id
      left join roles r on r.id = mr.role_id
      where m.organization_id = ${orgId} and m.user_id = ${uid} and m.status = 'active'`));
    const list = rows.rows as Array<{ department: string | null; key: string | null }>;
    if (!list.length) return { principals: [], department: null };
    const department = list[0]!.department;
    const principals = new Set<string>(["org:*", `user:${uid}`]);
    for (const r of list) if (r.key) principals.add(`role:${r.key}`);
    if (department) principals.add(deptPrincipal(department));
    return { principals: [...principals], department };
  }

  async function callerPrincipals(ctx: TenantContext, onBehalfOfUserId?: string): Promise<{ principals: string[]; userId: string | null; department: string | null }> {
    if (onBehalfOfUserId) {
      if (ctx.actor.type !== "system") throw forbidden("Only platform modules (system context) may query on behalf of a user.");
      return { ...(await userPrincipals(org(ctx), onBehalfOfUserId)), userId: onBehalfOfUserId };
    }
    if (ctx.actor.type === "user") return { ...(await userPrincipals(org(ctx), ctx.actor.id)), userId: ctx.actor.id };
    if (ctx.actor.type === "api_key" || ctx.actor.type === "agent") return { principals: ["org:*", `${ctx.actor.type}:${ctx.actor.id}`], userId: null, department: null };
    return { principals: ["org:*"], userId: null, department: null };
  }

  /** Map a source system's ACL to platform principals. Unresolvable entries are kept as "unmapped" and grant nothing (fail closed). */
  async function mapAcl(tx: Tx, orgId: string, perms: z.output<typeof permissionsInputSchema>, ownerUserId: string | null) {
    const principals = new Set<string>();
    const unmapped: AclEntry[] = [];
    if (perms.scope === "organization" || perms.scope === "public") principals.add("org:*");
    const roleKeys = new Set(((await tx.execute(sql`select key from roles where organization_id is null or organization_id = ${orgId}`)).rows as Array<{ key: string }>).map((r) => r.key.toLowerCase()));
    for (const e of perms.principals) {
      if (e.type === "domain" || e.type === "link" || e.type === "organization") principals.add("org:*");
      else if (e.type === "user") {
        const email = e.email ?? (e.id?.includes("@") ? e.id.toLowerCase() : undefined);
        const [u] = email
          ? await tx.select({ id: users.id }).from(users).innerJoin(memberships, eq(memberships.userId, users.id)).where(and(eq(memberships.organizationId, orgId), eq(memberships.status, "active"), sql`lower(${users.email}) = ${email}`)).limit(1)
          : e.id && isUuid(e.id) ? await tx.select({ id: users.id }).from(users).innerJoin(memberships, eq(memberships.userId, users.id)).where(and(eq(memberships.organizationId, orgId), eq(users.id, e.id))).limit(1) : [];
        if (u) principals.add(`user:${u.id}`);
        else unmapped.push(e);
      } else if (e.type === "role" && e.name && roleKeys.has(e.name.toLowerCase())) principals.add(`role:${e.name.toLowerCase()}`);
      else if (e.type === "department" && e.name) principals.add(deptPrincipal(e.name));
      else if (e.type === "group" && e.name) {
        const n = e.name.trim().toLowerCase();
        if (/^(everyone|all ?(users|staff|employees|company)|domain users|authenticated users)$/.test(n)) principals.add("org:*");
        else if (roleKeys.has(n)) principals.add(`role:${n}`);
        else {
          const [dept] = await tx.select({ d: memberships.department }).from(memberships).where(and(eq(memberships.organizationId, orgId), sql`lower(${memberships.department}) = ${n}`)).limit(1);
          if (dept) principals.add(deptPrincipal(n));
          else unmapped.push(e);
        }
      } else unmapped.push(e);
    }
    if (ownerUserId) principals.add(`user:${ownerUserId}`);
    return { principals: [...principals], unmapped };
  }

  async function memberByEmail(tx: Tx, orgId: string, email: string | null | undefined) {
    if (!email) return null;
    const [u] = await tx.select({ id: users.id, name: users.name }).from(users).innerJoin(memberships, eq(memberships.userId, users.id)).where(and(eq(memberships.organizationId, orgId), eq(memberships.status, "active"), sql`lower(${users.email}) = ${email.toLowerCase()}`)).limit(1);
    return u ?? null;
  }
  async function assertMember(tx: Tx, orgId: string, uid: string | null | undefined, field: string) {
    if (!uid) return;
    const r = await tx.execute(sql`select 1 from memberships where organization_id = ${orgId} and user_id = ${uid} and status = 'active' limit 1`);
    if (!r.rows.length) throw new AppError("VALIDATION_FAILED", `${field} must be an active member of this organization.`);
  }

  async function canAccessDocument(ctx: TenantContext, documentId: string): Promise<boolean> {
    if (await authorizer.can(ctx, "knowledge.manage")) return true;
    const { principals } = await callerPrincipals(ctx);
    if (!principals.length) return false;
    const [p] = await tenant(ctx, (tx) => tx.select({ principals: knowledgePermissions.principals }).from(knowledgePermissions).where(eq(knowledgePermissions.documentId, documentId)).limit(1));
    return !!p && p.principals.some((x) => principals.includes(x));
  }

  // ── Reviews ─────────────────────────────────────────────────────────────
  async function openReview(tx: Tx, orgId: string, r: { kind: ReviewKind; title: string; detail: string; dedupeKey: string; documentId?: string | null; queryId?: string | null; conflictId?: string | null; category?: string | null; assigneeUserId?: string | null }) {
    const [row] = await tx.insert(knowledgeReviews).values({ organizationId: orgId, kind: r.kind, title: r.title.slice(0, 300), detail: r.detail.slice(0, 4000), dedupeKey: r.dedupeKey, documentId: r.documentId ?? null, queryId: r.queryId ?? null, conflictId: r.conflictId ?? null, category: r.category ?? null, assigneeUserId: r.assigneeUserId ?? null })
      .onConflictDoUpdate({ target: [knowledgeReviews.organizationId, knowledgeReviews.dedupeKey], set: { status: sql`case when ${knowledgeReviews.status} in ('resolved','dismissed') then 'open' else ${knowledgeReviews.status} end`, detail: r.detail.slice(0, 4000), updatedAt: new Date() }, where: sql`${knowledgeReviews.status} in ('resolved','dismissed') or ${knowledgeReviews.detail} <> ${r.detail.slice(0, 4000)}` })
      .returning();
    return row ?? null;
  }

  // ── Ingestion ───────────────────────────────────────────────────────────
  type DocInput = z.output<typeof documentInputSchema>;
  async function ingest(ctx: TenantContext, source: SourceRow, input: DocInput, via: string) {
    const orgId = source.organizationId;
    const format: DocFormat | null = input.format ?? (input.record !== undefined ? "json" : formatFromName(input.filename ?? input.title!, input.mimeType)) ?? (input.text !== undefined ? "txt" : null);
    if (!format) throw new AppError("VALIDATION_FAILED", "Unsupported or unknown format. Supported: PDF, DOCX, PPTX, XLSX, CSV, TXT, HTML, JSON records.");
    const externalId = input.externalId ?? (input.filename ?? input.title!).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 300);
    let extraction: ReturnType<typeof extract> | null = null;
    let error: string | null = null;
    try {
      const body = input.record !== undefined ? JSON.stringify(input.record) : input.contentBase64 !== undefined ? Buffer.from(input.contentBase64, "base64") : input.text!;
      extraction = extract(format, body);
      if (!extraction.text.trim()) error = extraction.warnings[0] ?? "No text could be extracted.";
    } catch (e) {
      error = e instanceof Error ? e.message.slice(0, 500) : "Extraction failed.";
    }
    const text = extraction?.text ?? "";
    const hash = sha256(text);
    const title = (input.title || extraction?.metadata.title?.trim() || input.filename!).slice(0, 500);
    const index = await indexFor(orgId);

    const res = await orgScope(orgId, async (tx) => {
      const [existing] = await tx.select().from(knowledgeDocuments).where(and(eq(knowledgeDocuments.organizationId, orgId), eq(knowledgeDocuments.sourceId, source.id), eq(knowledgeDocuments.externalId, externalId))).limit(1);
      const owner = await memberByEmail(tx, orgId, input.owner);
      const meta = {
        title, format, sourceUrl: input.sourceUrl ?? existing?.sourceUrl ?? null, ownerUserId: owner?.id ?? (input.owner === undefined ? existing?.ownerUserId ?? source.ownerUserId : null),
        ownerLabel: owner ? null : input.owner ?? (input.owner === undefined ? existing?.ownerLabel ?? null : null), department: input.department ?? existing?.department ?? source.department,
        classification: input.classification ?? existing?.classification ?? source.classification, authority: input.authority === undefined ? existing?.authority ?? null : input.authority,
        effectiveDate: input.effectiveDate === undefined ? existing?.effectiveDate ?? null : input.effectiveDate, expirationDate: input.expirationDate === undefined ? existing?.expirationDate ?? null : input.expirationDate,
        reviewDueAt: input.reviewDueAt === undefined ? existing?.reviewDueAt ?? null : input.reviewDueAt, lastModifiedAt: input.lastModifiedAt ?? existing?.lastModifiedAt ?? new Date(),
      };
      const unchanged = !!existing && !error && existing.contentHash === hash && existing.ingestionStatus === "indexed";
      let doc: DocRow;
      let version = existing?.currentVersion ?? 0;
      if (error) {
        const values = { ...meta, ingestionStatus: "failed" as const, ingestionError: error, ingestionWarnings: extraction?.warnings ?? [], updatedAt: new Date() };
        doc = existing
          ? (await tx.update(knowledgeDocuments).set(values).where(eq(knowledgeDocuments.id, existing.id)).returning())[0]!
          : (await tx.insert(knowledgeDocuments).values({ ...values, organizationId: orgId, sourceId: source.id, externalId, createdBy: userId(ctx) }).returning())[0]!;
      } else if (unchanged) {
        doc = (await tx.update(knowledgeDocuments).set({ ...meta, status: existing!.status === "archived" ? "active" : existing!.status, updatedAt: new Date() }).where(eq(knowledgeDocuments.id, existing!.id)).returning())[0]!;
      } else {
        version += 1;
        const chunks = chunk(text);
        const base = { ...meta, status: "active" as const, ingestionStatus: "indexed" as const, ingestionError: null, ingestionWarnings: extraction!.warnings, currentVersion: version, contentHash: hash, signature: minhash(text), charCount: text.length, chunkCount: chunks.length, updatedAt: new Date() };
        doc = existing
          ? (await tx.update(knowledgeDocuments).set(base).where(eq(knowledgeDocuments.id, existing.id)).returning())[0]!
          : (await tx.insert(knowledgeDocuments).values({ ...base, organizationId: orgId, sourceId: source.id, externalId, createdBy: userId(ctx) }).returning())[0]!;
        await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.documentId, doc.id));
        for (let i = 0; i < chunks.length; i += 200) {
          await tx.insert(knowledgeChunks).values(chunks.slice(i, i + 200).map((c) => ({ organizationId: orgId, documentId: doc.id, version, ordinal: c.ordinal, heading: c.heading, text: c.text, startOffset: c.start, endOffset: c.end, contentHash: c.hash })));
        }
        await tx.insert(knowledgeDocumentVersions).values({
          organizationId: orgId, documentId: doc.id, version, contentHash: hash, charCount: text.length, chunkCount: chunks.length, ingestedBy: `${ctx.actor.label} via ${via}`,
          metadata: { title: meta.title, format, effectiveDate: iso(meta.effectiveDate), expirationDate: iso(meta.expirationDate), classification: meta.classification, extractedTitle: extraction!.metadata.title ?? null, headings: extraction!.headings.slice(0, 50) },
          changeSummary: existing ? `Content changed (${existing.charCount} → ${text.length} characters)` : "First version",
        });
        await index.indexDocument(tx, { organizationId: orgId, documentId: doc.id, version });
      }
      // Permissions: explicit edits are kept; otherwise source ACL or source default.
      const [perm] = await tx.select().from(knowledgePermissions).where(eq(knowledgePermissions.documentId, doc.id)).limit(1);
      if (!perm || perm.mode !== "explicit") {
        const mapped = input.permissions ? await mapAcl(tx, orgId, input.permissions, doc.ownerUserId) : { principals: [...source.defaultPrincipals, ...(doc.ownerUserId ? [`user:${doc.ownerUserId}`] : [])], unmapped: [] as AclEntry[] };
        const values = { mode: input.permissions ? ("source_acl" as const) : ("source_default" as const), rawAcl: input.permissions?.principals ?? [], principals: [...new Set(mapped.principals)], unmapped: mapped.unmapped, updatedBy: ctx.actor.label, updatedAt: new Date() };
        if (perm) await tx.update(knowledgePermissions).set(values).where(eq(knowledgePermissions.id, perm.id));
        else await tx.insert(knowledgePermissions).values({ ...values, organizationId: orgId, documentId: doc.id });
      }
      return { doc, created: !existing, unchanged, failed: !!error, version };
    });

    if (res.failed) {
      await record(ctx, "knowledge.document_ingest_failed", "knowledge_document", res.doc.id, { outcome: "failure", metadata: { title, format, error } });
    } else if (!res.unchanged) {
      await bus.publish(ctx, res.created ? "knowledge.document.ingested" : "knowledge.document.updated", { documentId: res.doc.id, sourceId: source.id, version: res.version, chunkCount: res.doc.chunkCount });
      await record(ctx, res.created ? "knowledge.document_ingested" : "knowledge.document_updated", "knowledge_document", res.doc.id, { after: { title: res.doc.title, version: res.version, format, chunks: res.doc.chunkCount, classification: res.doc.classification } });
      await detectConflicts(ctx, res.doc.id);
      await refreshIndexStats(orgId);
    }
    await freshnessFor(orgId, [res.doc.id]);
    return { document: documentView(res.doc, { sourceName: source.name, sourceAuthority: source.authority }), created: res.created, unchanged: res.unchanged, failed: res.failed, error };
  }

  async function documentText(tx: Tx, docId: string, version: number) {
    const rows = await tx.select({ text: knowledgeChunks.text }).from(knowledgeChunks).where(and(eq(knowledgeChunks.documentId, docId), eq(knowledgeChunks.version, version))).orderBy(knowledgeChunks.ordinal);
    return rows.map((r) => r.text).join("\n\n").slice(0, 60_000);
  }

  /** Compare a document with likely related documents (same hash, similar title, shared top terms) and record conflicts for reviewers. */
  async function detectConflicts(ctx: TenantContext, docId: string) {
    const orgId = org(ctx);
    const found = await orgScope(orgId, async (tx) => {
      const [doc] = await tx.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, docId)).limit(1);
      if (!doc || doc.status !== "active" || doc.ingestionStatus !== "indexed") return [];
      const text = await documentText(tx, doc.id, doc.currentVersion);
      const freq = new Map<string, number>();
      for (const t of terms(text)) if (!/^\d/.test(t)) freq.set(t, (freq.get(t) ?? 0) + 1);
      const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t]) => t).join(" ");
      const q = toTsQuery(top);
      const byTerms = q
        ? ((await tx.execute(sql`select c.document_id, max(ts_rank_cd(c.tsv, to_tsquery('english', ${q}), 32)) as r from knowledge_chunks c join knowledge_documents d on d.id = c.document_id and c.version = d.current_version where c.organization_id = ${orgId} and d.status = 'active' and c.document_id <> ${doc.id} and c.tsv @@ to_tsquery('english', ${q}) group by c.document_id order by r desc limit 15`)).rows as Array<{ document_id: string }>).map((r) => r.document_id)
        : [];
      const sameHash = (await tx.select({ id: knowledgeDocuments.id }).from(knowledgeDocuments).where(and(eq(knowledgeDocuments.organizationId, orgId), eq(knowledgeDocuments.contentHash, doc.contentHash!), ne(knowledgeDocuments.id, doc.id), eq(knowledgeDocuments.status, "active")))).map((r) => r.id);
      const ids = [...new Set([...sameHash, ...byTerms])].slice(0, 20);
      if (!ids.length) return [];
      const others = await tx.select().from(knowledgeDocuments).where(and(inArray(knowledgeDocuments.id, ids), eq(knowledgeDocuments.ingestionStatus, "indexed")));
      const me: DocForComparison = { id: doc.id, title: doc.title, text, hash: doc.contentHash!, signature: doc.signature, effectiveDate: doc.effectiveDate, lastModifiedAt: doc.lastModifiedAt };
      const created: Array<{ id: string; kind: string; a: string; b: string; detail: string }> = [];
      for (const o of others) {
        const cmp = compare(me, { id: o.id, title: o.title, text: await documentText(tx, o.id, o.currentVersion), hash: o.contentHash!, signature: o.signature, effectiveDate: o.effectiveDate, lastModifiedAt: o.lastModifiedAt });
        if (!cmp) continue;
        const [a, b, newer] = doc.id < o.id ? [doc, o, cmp.newer] : [o, doc, cmp.newer === "a" ? "b" : cmp.newer === "b" ? "a" : null];
        const [row] = await tx.insert(knowledgeConflicts).values({ organizationId: orgId, kind: cmp.kind, documentAId: a.id, documentBId: b.id, similarity: Math.round(cmp.similarity * 10000) / 10000, newer: newer as "a" | "b" | null, detail: cmp.detail, evidence: cmp.evidence })
          .onConflictDoUpdate({ target: [knowledgeConflicts.documentAId, knowledgeConflicts.documentBId, knowledgeConflicts.kind], set: { similarity: Math.round(cmp.similarity * 10000) / 10000, newer: newer as "a" | "b" | null, detail: cmp.detail, evidence: cmp.evidence, status: sql`case when ${knowledgeConflicts.status} = 'resolved' and ${knowledgeConflicts.resolution} in ('keep_a','keep_b') then ${knowledgeConflicts.status} else 'open' end`, detectedAt: new Date() } })
          .returning({ id: knowledgeConflicts.id, status: knowledgeConflicts.status, detectedAt: knowledgeConflicts.detectedAt });
        if (row?.status === "open") {
          const label = { duplicate: "Duplicate", near_duplicate: "Near-duplicate", newer_version: "Newer version", contradiction: "Contradiction" }[cmp.kind];
          const rv = await openReview(tx, orgId, { kind: "conflict", title: `${label}: "${a.title}" ↔ "${b.title}"`, detail: cmp.detail, dedupeKey: `conflict:${row.id}`, conflictId: row.id });
          if (rv) created.push({ id: row.id, kind: cmp.kind, a: a.id, b: b.id, detail: cmp.detail });
        }
      }
      return created;
    });
    for (const c of found) {
      await bus.publish(ctx, "knowledge.conflict.detected", { conflictId: c.id, kind: c.kind, documentAId: c.a, documentBId: c.b });
      await record(ctx, "knowledge.conflict_detected", "knowledge_conflict", c.id, { metadata: { kind: c.kind, documentAId: c.a, documentBId: c.b } });
      if (c.kind === "contradiction") await notifications.notify(ctx, { type: "knowledge.conflict", title: "Contradictory documents need a reviewer", body: c.detail.slice(0, 300), actionUrl: `${BASE}/reviews?tab=conflicts&focus=${c.id}`, priority: "high", recipients: { permission: "knowledge.conflict.review" } });
    }
  }

  /** Freshness review queues for the given documents (or all active documents). */
  async function freshnessFor(orgId: string, docIds?: string[]) {
    const st = await settings(orgId);
    const now = new Date();
    const created = await orgScope(orgId, async (tx) => {
      const docs = await tx.select({ d: knowledgeDocuments, staleDays: knowledgeSources.staleDays }).from(knowledgeDocuments).innerJoin(knowledgeSources, eq(knowledgeSources.id, knowledgeDocuments.sourceId))
        .where(and(eq(knowledgeDocuments.organizationId, orgId), eq(knowledgeDocuments.status, "active"), eq(knowledgeDocuments.ingestionStatus, "indexed"), docIds ? inArray(knowledgeDocuments.id, docIds) : undefined));
      const out: string[] = [];
      for (const { d, staleDays } of docs) {
        const f = freshnessOf(d, now, staleDays ?? st.staleDays);
        const want: Array<{ kind: ReviewKind; title: string; detail: string }> = [];
        if (f === "expired") want.push({ kind: "expired", title: `Expired: ${d.title}`, detail: `Expired on ${d.expirationDate!.toISOString().slice(0, 10)}. Expired documents are never used in answers. Renew, replace or archive it.` });
        else if (f === "stale") {
          const due = d.reviewDueAt && d.reviewDueAt <= now;
          want.push({ kind: due ? "review_due" : "stale", title: `${due ? "Review due" : "Stale"}: ${d.title}`, detail: due ? `Review was due on ${d.reviewDueAt!.toISOString().slice(0, 10)}.` : `Not modified for more than ${staleDays ?? st.staleDays} days.` });
        }
        if (!d.ownerUserId) want.push({ kind: "no_owner", title: `No owner: ${d.title}`, detail: "Assign an accountable owner who keeps this document current." });
        for (const w of want) {
          const r = await openReview(tx, orgId, { ...w, dedupeKey: `${w.kind}:${d.id}`, documentId: d.id, assigneeUserId: d.ownerUserId });
          if (r && r.createdAt.getTime() >= now.getTime() - 1000) out.push(r.id);
        }
        // Close freshness reviews that no longer apply.
        const kinds: ReviewKind[] = ["expired", "stale", "review_due", "no_owner"];
        const keep = new Set(want.map((w) => w.kind));
        await tx.update(knowledgeReviews).set({ status: "resolved", resolution: "No longer applies.", resolvedAt: now, updatedAt: now }).where(and(eq(knowledgeReviews.documentId, d.id), inArray(knowledgeReviews.kind, kinds.filter((k) => !keep.has(k))), inArray(knowledgeReviews.status, ["open", "in_progress"])));
      }
      return out;
    });
    if (created.length) {
      const ctx = sysCtx(orgId);
      for (const id of created.slice(0, 50)) await bus.publish(ctx, "knowledge.review.required", { reviewId: id, kind: "freshness" });
      await notifications.notify(ctx, { type: "knowledge.review_required", title: `${created.length} knowledge document(s) need review`, body: "Stale, expired or ownerless documents were added to the review queue.", actionUrl: `${BASE}/reviews`, recipients: { permission: "knowledge.manage" } });
    }
    return created.length;
  }

  // ── Retrieval ───────────────────────────────────────────────────────────
  async function retrievePassages(ctx: TenantContext, question: string, principals: string[], limit = CONTEXT_PASSAGES): Promise<{ passages: RetrievedPassage[]; topRelevance: number }> {
    const orgId = org(ctx);
    if (!principals.length) return { passages: [], topRelevance: 0 };
    const index = await indexFor(orgId);
    const st = await settings(orgId);
    const now = new Date();
    return orgScope(orgId, async (tx) => {
      const hits = await index.search(tx, { organizationId: orgId, query: question, principals, limit: 40 });
      if (!hits.length) return { passages: [], topRelevance: 0 };
      // Defence in depth: re-check every hit against the database ACL and document state before any text is used.
      const rows = await tx.select({ c: knowledgeChunks, d: knowledgeDocuments, s: knowledgeSources, p: knowledgePermissions.principals })
        .from(knowledgeChunks).innerJoin(knowledgeDocuments, eq(knowledgeDocuments.id, knowledgeChunks.documentId)).innerJoin(knowledgeSources, eq(knowledgeSources.id, knowledgeDocuments.sourceId))
        .innerJoin(knowledgePermissions, eq(knowledgePermissions.documentId, knowledgeDocuments.id))
        .where(and(eq(knowledgeChunks.organizationId, orgId), inArray(knowledgeChunks.id, hits.map((h) => h.chunkId))));
      const rel = new Map(hits.map((h) => [h.chunkId, h.relevance]));
      const permitted = rows.filter(({ c, d, p }) => d.status === "active" && d.ingestionStatus === "indexed" && c.version === d.currentVersion && p.some((x) => principals.includes(x)) && freshnessOf(d, now, 36500) !== "expired");
      // Drop the weak tail: passages far less relevant than the best one only add noise (and spurious conflicts) to the context.
      const top = Math.max(0, ...permitted.map(({ c }) => rel.get(c.id) ?? 0));
      const allowed = permitted.filter(({ c }) => (rel.get(c.id) ?? 0) >= top * 0.3);
      if (permitted.length < rows.length) logger.warn("knowledge.index_returned_unauthorized", { provider: index.key, dropped: rows.length - permitted.length });
      const ranked = rank(allowed.map(({ c, d, s }) => ({ c, d, s, relevance: rel.get(c.id) ?? 0, authority: (d.authority ?? s.authority) as Authority, freshness: freshnessOf(d, now, s.staleDays ?? st.staleDays), effectiveDate: d.effectiveDate ?? d.lastModifiedAt })));
      // At most two passages per document, so several sources get a voice.
      const perDoc = new Map<string, number>();
      const picked = ranked.filter((r) => {
        const n = perDoc.get(r.d.id) ?? 0;
        if (n >= 2) return false;
        perDoc.set(r.d.id, n + 1);
        return true;
      }).slice(0, limit);
      return {
        topRelevance: top,
        passages: picked.map((r, i) => ({ marker: `S${i + 1}`, chunkId: r.c.id, documentId: r.d.id, title: r.d.title, sourceName: r.s.name, text: r.c.text, heading: r.c.heading, authority: r.authority, freshness: r.freshness as "fresh" | "stale", documentDate: iso(r.d.effectiveDate ?? r.d.lastModifiedAt), version: r.d.currentVersion, classification: r.d.classification, score: Math.round(r.score * 10000) / 10000 })),
      };
    });
  }

  async function generate(ctx: TenantContext, question: string, passages: RetrievedPassage[]) {
    const prompt = `Sources:\n\n${passages.map((p) => `[${p.marker}] ${p.title} — ${p.authority}${p.freshness === "stale" ? ", past review date" : ""}${p.documentDate ? `, dated ${p.documentDate.slice(0, 10)}` : ""}\n${p.heading ? `Section: ${p.heading}\n` : ""}${p.text}`).join("\n\n")}\n\nQuestion: ${question}`;
    const order: Classification[] = ["public", "internal", "confidential", "restricted"];
    const dataClassification = passages.reduce<Classification>((m, p) => (order.indexOf(p.classification) > order.indexOf(m) ? p.classification : m), "internal");
    try {
      const res = await ai.execute(ctx, { moduleId: MODULE_ID, useCase: "knowledge.answer", system: ANSWER_SYSTEM, messages: [{ role: "user", content: prompt }], dataClassification, maxTokens: 1200 });
      if (res.text.startsWith("[SIMULATED]")) return { text: extractiveAnswer(question, passages), mode: "extractive" as const, note: "The configured AI provider is simulated, so this answer quotes the sources directly.", runId: res.runId, model: res.model };
      return { text: res.text.trim(), mode: "generative" as const, note: null, runId: res.runId, model: res.model };
    } catch (err) {
      const code = isAppError(err) ? err.code : "UPSTREAM_ERROR";
      const why: Record<string, string> = {
        NOT_CONFIGURED: "No AI model is configured", FORBIDDEN: "You are not permitted to use AI generation (ai.use)", POLICY_DENIED: "An AI policy or DLP blocked generation",
        APPROVAL_REQUIRED: "AI generation for this content needs approval", RATE_LIMITED: "The AI rate limit was reached", MODULE_NOT_ENABLED: "AI generation is unavailable",
      };
      if (!isAppError(err)) logger.warn("knowledge.generation_failed", { error: err instanceof Error ? err.message : String(err) });
      return { text: extractiveAnswer(question, passages), mode: "extractive" as const, note: `${why[code] ?? "AI generation failed"}; this answer quotes the sources directly.`, runId: (isAppError(err) ? (err.details as { runId?: string } | undefined)?.runId : undefined) ?? null, model: null };
    }
  }

  async function escalationTargets(cat: EscalationCategory) {
    return cat.expertUserIds.length ? { userIds: cat.expertUserIds } : { permission: "knowledge.conflict.review" as const };
  }

  const service = {
    registerIndexProvider(p: KnowledgeIndexProvider) {
      if (providers.has(p.key)) throw new Error(`Index provider "${p.key}" already registered`);
      providers.set(p.key, p);
    },

    // ── Settings ──────────────────────────────────────────────────────────
    async getSettings(ctx: TenantContext) {
      await authorizer.require(ctx, "knowledge.read");
      const s = await settings(org(ctx));
      return { staleDays: s.staleDays, reviewIntervalDays: s.reviewIntervalDays, storeQuestions: s.storeQuestions, escalationCategories: categoriesOf(s), customizedCategories: s.escalationCategories !== null };
    },
    async updateSettings(ctx: TenantContext, raw: unknown) {
      await authorizer.require(ctx, "knowledge.admin");
      const input = parse(settingsSchema, raw);
      if (input.escalationCategories) for (const c of input.escalationCategories) await tenant(ctx, async (tx) => { for (const u of c.expertUserIds) await assertMember(tx, org(ctx), u, `Expert for ${c.label}`); });
      const before = await settings(org(ctx));
      await tenant(ctx, (tx) => tx.update(knowledgeSettings).set({ ...input, updatedBy: userId(ctx), updatedAt: new Date() }).where(eq(knowledgeSettings.organizationId, org(ctx))));
      await record(ctx, "knowledge.settings_updated", "knowledge_settings", org(ctx), { before: { staleDays: before.staleDays, reviewIntervalDays: before.reviewIntervalDays, storeQuestions: before.storeQuestions }, after: input });
      return service.getSettings(ctx);
    },
    async listIndexes(ctx: TenantContext) {
      await authorizer.require(ctx, "knowledge.admin");
      await indexFor(org(ctx));
      await refreshIndexStats(org(ctx));
      const rows = await tenant(ctx, (tx) => tx.select().from(knowledgeIndexes).where(eq(knowledgeIndexes.organizationId, org(ctx))));
      return rows.map((r) => ({ id: r.id, name: r.name, provider: r.provider, description: providers.get(r.provider)?.description ?? "Provider not registered in this deployment", isDefault: r.isDefault, status: r.status, documentCount: r.documentCount, chunkCount: r.chunkCount, lastBuiltAt: iso(r.lastBuiltAt) }));
    },

    // ── Sources ───────────────────────────────────────────────────────────
    async listSources(ctx: TenantContext) {
      await authorizer.require(ctx, "knowledge.read");
      return tenant(ctx, async (tx) => {
        const rows = await tx.select().from(knowledgeSources).where(eq(knowledgeSources.organizationId, org(ctx))).orderBy(knowledgeSources.name);
        const counts = await tx.select({ s: knowledgeDocuments.sourceId, n: sql<number>`count(*) filter (where ${knowledgeDocuments.status} = 'active')::int`, failed: sql<number>`count(*) filter (where ${knowledgeDocuments.ingestionStatus} = 'failed')::int` }).from(knowledgeDocuments).where(eq(knowledgeDocuments.organizationId, org(ctx))).groupBy(knowledgeDocuments.sourceId);
        const cm = new Map(counts.map((c) => [c.s, c]));
        return rows.map((s) => ({ ...sourceView(s), documents: cm.get(s.id)?.n ?? 0, failed: cm.get(s.id)?.failed ?? 0 }));
      });
    },
    async createSource(ctx: TenantContext, raw: unknown) {
      await authorizer.require(ctx, "knowledge.source.manage");
      const input = parse(sourceInputSchema, raw);
      if (input.kind === "connector") {
        if (!input.connectorId) throw new AppError("VALIDATION_FAILED", "connectorId is required for connector sources.");
        await connectors.get(sysCtx(org(ctx)), input.connectorId).catch((e: unknown) => {
          if (isAppError(e) && e.code === "NOT_FOUND") throw new AppError("VALIDATION_FAILED", "Unknown connector.");
          throw e;
        });
      }
      const row = await tenant(ctx, async (tx) => {
        await assertMember(tx, org(ctx), input.ownerUserId, "Owner");
        const [dup] = await tx.select({ id: knowledgeSources.id }).from(knowledgeSources).where(and(eq(knowledgeSources.organizationId, org(ctx)), eq(knowledgeSources.name, input.name))).limit(1);
        if (dup) throw conflict(`A source named "${input.name}" already exists.`);
        const [s] = await tx.insert(knowledgeSources).values({ organizationId: org(ctx), name: input.name, kind: input.kind, connectorId: input.kind === "connector" ? input.connectorId! : null, config: input.path ? { path: input.path } : {}, authority: input.authority, ownerUserId: input.ownerUserId ?? null, department: input.department ?? null, classification: input.classification, defaultPrincipals: input.defaultPrincipals, staleDays: input.staleDays ?? null, createdBy: userId(ctx) }).returning();
        return s!;
      });
      await record(ctx, "knowledge.source_created", "knowledge_source", row.id, { after: sourceView(row) });
      return sourceView(row);
    },
    async updateSource(ctx: TenantContext, id: string, raw: unknown) {
      await authorizer.require(ctx, "knowledge.source.manage");
      const input = parse(sourceInputSchema.partial().extend({ status: z.enum(["active", "paused"]).optional() }), raw);
      uuidOr404(id, "Source");
      const res = await tenant(ctx, async (tx) => {
        const [s] = await tx.select().from(knowledgeSources).where(and(eq(knowledgeSources.organizationId, org(ctx)), eq(knowledgeSources.id, id))).limit(1);
        if (!s) throw notFound("Source", id);
        await assertMember(tx, org(ctx), input.ownerUserId, "Owner");
        const [u] = await tx.update(knowledgeSources).set({
          ...(input.name ? { name: input.name } : {}), ...(input.authority ? { authority: input.authority } : {}), ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}), ...(input.department !== undefined ? { department: input.department } : {}),
          ...(input.classification ? { classification: input.classification } : {}), ...(input.defaultPrincipals ? { defaultPrincipals: input.defaultPrincipals } : {}), ...(input.staleDays !== undefined ? { staleDays: input.staleDays } : {}),
          ...(input.path !== undefined ? { config: { ...s.config, path: input.path } } : {}), ...(input.status ? { status: input.status } : {}), updatedAt: new Date(),
        }).where(eq(knowledgeSources.id, id)).returning();
        if (input.defaultPrincipals) {
          // Documents that inherit the source default follow the change immediately.
          await tx.execute(sql`update knowledge_permissions_metadata p set principals = ${pgTextArray(input.defaultPrincipals)}::text[] || case when d.owner_user_id is null then '{}'::text[] else array['user:' || d.owner_user_id::text] end, updated_at = now() from knowledge_documents d where d.id = p.document_id and d.source_id = ${id} and p.mode = 'source_default'`);
        }
        return { before: s, after: u! };
      });
      await record(ctx, "knowledge.source_updated", "knowledge_source", id, { before: sourceView(res.before), after: sourceView(res.after) });
      return sourceView(res.after);
    },
    async syncSource(ctx: TenantContext, id: string) {
      await authorizer.require(ctx, "knowledge.ingest");
      uuidOr404(id, "Source");
      const [s] = await tenant(ctx, (tx) => tx.update(knowledgeSources).set({ lastSyncStatus: "queued", lastSyncMessage: null }).where(and(eq(knowledgeSources.organizationId, org(ctx)), eq(knowledgeSources.id, id))).returning());
      if (!s) throw notFound("Source", id);
      if (s.kind !== "connector") throw new AppError("VALIDATION_FAILED", "Only connector sources can be synced; upload documents to this source instead.");
      await jobs.enqueue(SYNC_JOB, { sourceId: id, requestedBy: ctx.actor.label }, { organizationId: org(ctx), idempotencyKey: `kv-sync:${id}:${Date.now()}`, correlationId: ctx.correlationId });
      await record(ctx, "knowledge.source_sync_requested", "knowledge_source", id);
      return { queued: true };
    },

    /** Job handler: pull documents through the shared connector. */
    async runSync(orgId: string, sourceId: string) {
      const ctx = sysCtx(orgId);
      const [s] = await orgScope(orgId, (tx) => tx.update(knowledgeSources).set({ lastSyncStatus: "running" }).where(eq(knowledgeSources.id, sourceId)).returning());
      if (!s || !s.connectorId) return;
      try {
        const c = await connectors.get(ctx, s.connectorId);
        let items: Array<Record<string, unknown>>;
        if (c.type === "sandbox") {
          const out = (await connectors.execute(ctx, c.id, { capability: "files.list", operation: "list", params: {} }, { moduleId: MODULE_ID })) as { files?: Array<Record<string, unknown>> };
          // File content arrives as text: keep text-native formats (CSV rows become "column: value" lines); everything else is plain text.
          const textFormat = (name: unknown) => {
            const f = formatFromName(String(name ?? ""), undefined);
            return f === "csv" || f === "html" || f === "json" ? f : "txt";
          };
          items = (out.files ?? []).map((f) => ({ externalId: f.id, title: f.name, format: textFormat(f.name), text: f.content, owner: f.owner, department: f.department, lastModifiedAt: f.lastModifiedAt, permissions: f.permissions }));
        } else if (c.type === "rest_api") {
          const path = String((s.config as { path?: string }).path ?? "");
          if (!path) throw new AppError("VALIDATION_FAILED", "Set the source's documents endpoint path (e.g. /knowledge/documents).");
          const out = (await connectors.execute(ctx, c.id, { capability: "http.request", operation: "read", params: { method: "GET", path } }, { moduleId: MODULE_ID })) as { body?: unknown };
          const body = out.body as { documents?: unknown[] } | unknown[];
          items = (Array.isArray(body) ? body : Array.isArray(body?.documents) ? body.documents : []) as Array<Record<string, unknown>>;
        } else {
          throw new AppError("NOT_IMPLEMENTED", `No document adapter for ${c.type} yet. Push its documents through POST /api/v1/m/knowledge-verification/documents instead.`);
        }
        let ok = 0;
        let failed = 0;
        const seen: string[] = [];
        for (const item of items.slice(0, 2000)) {
          const parsed = documentInputSchema.safeParse({ ...item, sourceId, owner: item.owner ?? null });
          if (!parsed.success) {
            failed++;
            continue;
          }
          const r = await ingest(ctx, s, parsed.data, `connector:${c.type}`);
          seen.push(r.document.externalId);
          if (r.failed) failed++;
          else ok++;
        }
        // Documents no longer present at the source are archived (never used in answers).
        const archived = seen.length ? await orgScope(orgId, (tx) => tx.update(knowledgeDocuments).set({ status: "archived", updatedAt: new Date() }).where(and(eq(knowledgeDocuments.sourceId, sourceId), eq(knowledgeDocuments.status, "active"), sql`${knowledgeDocuments.externalId} <> all(${pgTextArray(seen)}::text[])`)).returning({ id: knowledgeDocuments.id })) : [];
        await orgScope(orgId, (tx) => tx.update(knowledgeSources).set({ lastSyncAt: new Date(), lastSyncStatus: "succeeded", lastSyncMessage: `${ok} document(s) synced, ${failed} failed, ${archived.length} archived.` }).where(eq(knowledgeSources.id, sourceId)));
        await record(ctx, "knowledge.source_synced", "knowledge_source", sourceId, { metadata: { ok, failed, archived: archived.length } });
        await refreshIndexStats(orgId);
      } catch (err) {
        const message = isAppError(err) ? (/Capability ".+" is not enabled/.test(err.message) ? `${err.message} Enable it under Administration → Connectors.` : err.message) : "The connector call failed. See connector health for details.";
        await orgScope(orgId, (tx) => tx.update(knowledgeSources).set({ lastSyncAt: new Date(), lastSyncStatus: "failed", lastSyncMessage: message.slice(0, 500) }).where(eq(knowledgeSources.id, sourceId)));
        await record(ctx, "knowledge.source_sync_failed", "knowledge_source", sourceId, { outcome: "failure", metadata: { error: message.slice(0, 300) } });
      }
    },

    // ── Documents ─────────────────────────────────────────────────────────
    async ingestDocument(ctx: TenantContext, raw: unknown) {
      await authorizer.require(ctx, "knowledge.ingest");
      const input = parse(documentInputSchema, raw);
      const [s] = await tenant(ctx, (tx) => tx.select().from(knowledgeSources).where(and(eq(knowledgeSources.organizationId, org(ctx)), eq(knowledgeSources.id, input.sourceId))).limit(1));
      if (!s) throw notFound("Source", input.sourceId);
      if (s.status === "paused") throw conflict("This source is paused.");
      return ingest(ctx, s, input, ctx.actor.type === "user" ? "upload" : "api");
    },

    async listDocuments(ctx: TenantContext, q: { sourceId?: string; status?: string; q?: string } = {}) {
      await authorizer.require(ctx, "knowledge.read");
      const manage = await authorizer.can(ctx, "knowledge.manage");
      const { principals } = await callerPrincipals(ctx);
      const st = await settings(org(ctx));
      const now = new Date();
      return tenant(ctx, async (tx) => {
        const like = q.q ? `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
        const rows = await tx.select({ d: knowledgeDocuments, s: knowledgeSources, ownerName: users.name, p: knowledgePermissions.principals }).from(knowledgeDocuments)
          .innerJoin(knowledgeSources, eq(knowledgeSources.id, knowledgeDocuments.sourceId)).leftJoin(users, eq(users.id, knowledgeDocuments.ownerUserId)).leftJoin(knowledgePermissions, eq(knowledgePermissions.documentId, knowledgeDocuments.id))
          .where(and(eq(knowledgeDocuments.organizationId, org(ctx)), q.sourceId && isUuid(q.sourceId) ? eq(knowledgeDocuments.sourceId, q.sourceId) : undefined, q.status ? eq(knowledgeDocuments.status, q.status as "active") : undefined, like ? sql`${knowledgeDocuments.title} ilike ${like}` : undefined))
          .orderBy(desc(knowledgeDocuments.updatedAt)).limit(2000);
        return rows.filter((r) => manage || (r.p ?? []).some((x) => principals.includes(x))).map(({ d, s, ownerName }) => documentView(d, { sourceName: s.name, sourceAuthority: s.authority, ownerName, freshness: freshnessOf(d, now, s.staleDays ?? st.staleDays) }));
      });
    },

    async getDocument(ctx: TenantContext, id: string) {
      await authorizer.require(ctx, "knowledge.read");
      uuidOr404(id, "Document");
      if (!(await canAccessDocument(ctx, id))) throw notFound("Document", id);
      const st = await settings(org(ctx));
      return tenant(ctx, async (tx) => {
        const [row] = await tx.select({ d: knowledgeDocuments, s: knowledgeSources, ownerName: users.name }).from(knowledgeDocuments).innerJoin(knowledgeSources, eq(knowledgeSources.id, knowledgeDocuments.sourceId)).leftJoin(users, eq(users.id, knowledgeDocuments.ownerUserId)).where(and(eq(knowledgeDocuments.organizationId, org(ctx)), eq(knowledgeDocuments.id, id))).limit(1);
        if (!row) throw notFound("Document", id);
        const versions = await tx.select().from(knowledgeDocumentVersions).where(eq(knowledgeDocumentVersions.documentId, id)).orderBy(desc(knowledgeDocumentVersions.version)).limit(50);
        const [perm] = await tx.select().from(knowledgePermissions).where(eq(knowledgePermissions.documentId, id)).limit(1);
        const chunks = await tx.select({ id: knowledgeChunks.id, ordinal: knowledgeChunks.ordinal, heading: knowledgeChunks.heading, text: knowledgeChunks.text, start: knowledgeChunks.startOffset, end: knowledgeChunks.endOffset }).from(knowledgeChunks).where(and(eq(knowledgeChunks.documentId, id), eq(knowledgeChunks.version, row.d.currentVersion))).orderBy(knowledgeChunks.ordinal).limit(200);
        const conflicts = await tx.select({ c: knowledgeConflicts, ta: sql<string>`(select title from knowledge_documents where id = ${knowledgeConflicts.documentAId})`, tb: sql<string>`(select title from knowledge_documents where id = ${knowledgeConflicts.documentBId})` }).from(knowledgeConflicts).where(or(eq(knowledgeConflicts.documentAId, id), eq(knowledgeConflicts.documentBId, id))).orderBy(desc(knowledgeConflicts.detectedAt));
        const reviews = await tx.select().from(knowledgeReviews).where(eq(knowledgeReviews.documentId, id)).orderBy(desc(knowledgeReviews.createdAt)).limit(20);
        const [cites] = await tx.select({ n: sql<number>`count(*) filter (where ${knowledgeCitations.cited})::int` }).from(knowledgeCitations).where(eq(knowledgeCitations.documentId, id));
        const [superseder] = row.d.supersededByDocumentId ? await tx.select({ id: knowledgeDocuments.id, title: knowledgeDocuments.title }).from(knowledgeDocuments).where(eq(knowledgeDocuments.id, row.d.supersededByDocumentId)).limit(1) : [];
        return {
          ...documentView(row.d, { sourceName: row.s.name, sourceAuthority: row.s.authority, ownerName: row.ownerName, freshness: freshnessOf(row.d, new Date(), row.s.staleDays ?? st.staleDays) }),
          versions: versions.map((v) => ({ version: v.version, contentHash: v.contentHash, charCount: v.charCount, chunkCount: v.chunkCount, changeSummary: v.changeSummary, ingestedBy: v.ingestedBy, metadata: v.metadata, createdAt: v.createdAt.toISOString() })),
          permissions: perm ? { mode: perm.mode, principals: perm.principals, rawAcl: perm.rawAcl, unmapped: perm.unmapped, updatedAt: perm.updatedAt.toISOString() } : null,
          chunks: chunks.map((c) => ({ ...c, text: c.text.slice(0, 600) })),
          conflicts: conflicts.map(({ c, ta, tb }) => ({ id: c.id, kind: c.kind, status: c.status, detail: c.detail, otherDocumentId: c.documentAId === id ? c.documentBId : c.documentAId, otherTitle: c.documentAId === id ? tb : ta, detectedAt: c.detectedAt.toISOString() })),
          reviews: reviews.map((r) => ({ id: r.id, kind: r.kind, title: r.title, status: r.status, createdAt: r.createdAt.toISOString() })),
          citedCount: cites?.n ?? 0,
          supersededBy: superseder ?? null,
        };
      });
    },

    async updateDocument(ctx: TenantContext, id: string, raw: unknown) {
      await authorizer.require(ctx, "knowledge.manage");
      const input = parse(z.object({ ownerUserId: z.string().uuid().nullish(), department: text(120).nullish(), classification: classificationEnum.optional(), authority: z.enum(AUTHORITIES).nullish(), effectiveDate: dateish.nullish(), expirationDate: dateish.nullish(), reviewDueAt: dateish.nullish(), status: z.enum(["active", "archived"]).optional() }), raw);
      uuidOr404(id, "Document");
      const res = await tenant(ctx, async (tx) => {
        const [d] = await tx.select().from(knowledgeDocuments).where(and(eq(knowledgeDocuments.organizationId, org(ctx)), eq(knowledgeDocuments.id, id))).limit(1);
        if (!d) throw notFound("Document", id);
        await assertMember(tx, org(ctx), input.ownerUserId, "Owner");
        const [u] = await tx.update(knowledgeDocuments).set({ ...input, ...(input.ownerUserId !== undefined ? { ownerLabel: null } : {}), updatedAt: new Date() }).where(eq(knowledgeDocuments.id, id)).returning();
        if (input.ownerUserId) await tx.execute(sql`update knowledge_permissions_metadata set principals = array(select distinct unnest(principals || array[${`user:${input.ownerUserId}`}])) where document_id = ${id} and mode <> 'explicit'`);
        return { before: d, after: u! };
      });
      await record(ctx, "knowledge.document_metadata_updated", "knowledge_document", id, { before: documentView(res.before), after: input });
      await freshnessFor(org(ctx), [id]);
      return documentView(res.after);
    },

    async setDocumentPermissions(ctx: TenantContext, id: string, raw: unknown) {
      await authorizer.require(ctx, "knowledge.source.manage");
      const input = parse(z.object({ mode: z.enum(["explicit", "source_default"]), principals: z.array(z.string().regex(PRINCIPAL_RE)).max(500).default([]) }), raw);
      uuidOr404(id, "Document");
      const res = await tenant(ctx, async (tx) => {
        const [d] = await tx.select({ d: knowledgeDocuments, s: knowledgeSources }).from(knowledgeDocuments).innerJoin(knowledgeSources, eq(knowledgeSources.id, knowledgeDocuments.sourceId)).where(and(eq(knowledgeDocuments.organizationId, org(ctx)), eq(knowledgeDocuments.id, id))).limit(1);
        if (!d) throw notFound("Document", id);
        for (const p of input.principals.filter((x) => x.startsWith("user:"))) await assertMember(tx, org(ctx), p.slice(5), "Principal");
        const principals = input.mode === "explicit" ? input.principals : [...d.s.defaultPrincipals, ...(d.d.ownerUserId ? [`user:${d.d.ownerUserId}`] : [])];
        const [before] = await tx.select().from(knowledgePermissions).where(eq(knowledgePermissions.documentId, id)).limit(1);
        await tx.insert(knowledgePermissions).values({ organizationId: org(ctx), documentId: id, mode: input.mode, principals: [...new Set(principals)], updatedBy: ctx.actor.label })
          .onConflictDoUpdate({ target: knowledgePermissions.documentId, set: { mode: input.mode, principals: [...new Set(principals)], updatedBy: ctx.actor.label, updatedAt: new Date() } });
        return { before: before?.principals ?? [], after: principals };
      });
      await record(ctx, "knowledge.document_permissions_changed", "knowledge_document", id, { before: { principals: res.before }, after: { mode: input.mode, principals: res.after } });
      return { mode: input.mode, principals: res.after };
    },

    async markReviewed(ctx: TenantContext, id: string, raw: unknown) {
      await authorizer.require(ctx, "knowledge.manage");
      const input = parse(z.object({ note: text(1000).optional(), nextReviewDays: z.number().int().min(7).max(3650).optional() }), raw);
      uuidOr404(id, "Document");
      const st = await settings(org(ctx));
      const due = new Date(Date.now() + (input.nextReviewDays ?? st.reviewIntervalDays) * 86400_000);
      const [d] = await tenant(ctx, (tx) => tx.update(knowledgeDocuments).set({ lastReviewedAt: new Date(), reviewDueAt: due, updatedAt: new Date() }).where(and(eq(knowledgeDocuments.organizationId, org(ctx)), eq(knowledgeDocuments.id, id))).returning());
      if (!d) throw notFound("Document", id);
      await tenant(ctx, (tx) => tx.update(knowledgeReviews).set({ status: "resolved", resolution: input.note ?? "Reviewed and still accurate.", resolvedBy: userId(ctx), resolvedAt: new Date(), updatedAt: new Date() }).where(and(eq(knowledgeReviews.documentId, id), inArray(knowledgeReviews.kind, ["stale", "review_due"]), inArray(knowledgeReviews.status, ["open", "in_progress"]))));
      await record(ctx, "knowledge.document_reviewed", "knowledge_document", id, { metadata: { note: input.note, nextReviewAt: due.toISOString() } });
      return documentView(d);
    },

    /** Shared API for other modules (e.g. Data Security): classification and governance metadata, permission-checked. */
    async documentMetadata(ctx: TenantContext, documentId: string, opts: { onBehalfOfUserId?: string } = {}) {
      await authorizer.require(ctx, "knowledge.read");
      uuidOr404(documentId, "Document");
      if (ctx.actor.type !== "system" || opts.onBehalfOfUserId) {
        const { principals } = await callerPrincipals(ctx, opts.onBehalfOfUserId);
        const [p] = await tenant(ctx, (tx) => tx.select({ principals: knowledgePermissions.principals }).from(knowledgePermissions).where(eq(knowledgePermissions.documentId, documentId)).limit(1));
        if (!p || !p.principals.some((x) => principals.includes(x))) throw notFound("Document", documentId);
      }
      const [row] = await tenant(ctx, (tx) => tx.select({ d: knowledgeDocuments, s: knowledgeSources, p: knowledgePermissions }).from(knowledgeDocuments).innerJoin(knowledgeSources, eq(knowledgeSources.id, knowledgeDocuments.sourceId)).leftJoin(knowledgePermissions, eq(knowledgePermissions.documentId, knowledgeDocuments.id)).where(and(eq(knowledgeDocuments.organizationId, org(ctx)), eq(knowledgeDocuments.id, documentId))).limit(1));
      if (!row) throw notFound("Document", documentId);
      return { documentId, title: row.d.title, source: { id: row.s.id, name: row.s.name, kind: row.s.kind, connectorId: row.s.connectorId }, classification: row.d.classification, authority: row.d.authority ?? row.s.authority, ownerUserId: row.d.ownerUserId, department: row.d.department, status: row.d.status, version: row.d.currentVersion, effectiveDate: iso(row.d.effectiveDate), expirationDate: iso(row.d.expirationDate), contentHash: row.d.contentHash, access: { mode: row.p?.mode ?? "source_default", principals: row.p?.principals ?? [], unmappedEntries: (row.p?.unmapped ?? []).length } };
    },

    // ── Retrieval & answering (shared API) ────────────────────────────────
    /** Permission-filtered passages for a question — what other modules use to ground their own prompts. */
    async retrieve(ctx: TenantContext, raw: unknown) {
      await authorizer.require(ctx, "knowledge.search");
      const input = parse(askSchema.extend({ limit: z.number().int().min(1).max(20).default(CONTEXT_PASSAGES) }), raw);
      const who = await callerPrincipals(ctx, input.onBehalfOfUserId);
      const r = await retrievePassages(ctx, input.question, who.principals, input.limit);
      await usage.record(ctx, { moduleId: MODULE_ID, metric: "knowledge.retrievals", unit: "request", quantity: 1, dimensions: { sourceModule: input.sourceModule ?? "api" } });
      return { passages: r.passages, topRelevance: r.topRelevance };
    },

    /** QUERY → IDENTITY → PERMISSION FILTER → RETRIEVAL → RANKING → GENERATION → CLAIMS → VERIFICATION → CONFIDENCE → CITED RESPONSE. */
    async ask(ctx: TenantContext, raw: unknown): Promise<AnswerView> {
      await authorizer.require(ctx, "knowledge.search");
      const input = parse(askSchema, raw);
      const started = performance.now();
      const orgId = org(ctx);
      const st = await settings(orgId);
      const who = await callerPrincipals(ctx, input.onBehalfOfUserId);
      const { passages, topRelevance } = await retrievePassages(ctx, input.question, who.principals);
      const categories = categorize(input.question, categoriesOf(st));

      let gen: Awaited<ReturnType<typeof generate>> | null = null;
      if (passages.length) gen = await generate(input.onBehalfOfUserId ? { ...ctx, actor: SYSTEM_ACTOR("knowledge_verification") } : ctx, input.question, passages);
      const response = gen?.text || null;
      const claims = response ? extractClaims(response) : [];
      const verified = claims.map((c) => ({ ...c, ...verifyClaim(c, passages) }));
      // Conflicts and staleness count only for documents the answer actually relies on (cited or supporting a claim).
      const used = new Set(verified.flatMap((c) => [...c.cited, ...c.supporting, ...c.contradicting]));
      const relied = used.size ? passages.filter((p) => used.has(p.marker)) : passages;
      const docIds = [...new Set(relied.map((p) => p.documentId))];
      const [openConf] = docIds.length ? await orgScope(orgId, (tx) => tx.select({ n: sql<number>`count(*)::int` }).from(knowledgeConflicts).where(and(eq(knowledgeConflicts.status, "open"), inArray(knowledgeConflicts.kind, ["contradiction", "newer_version"]), or(inArray(knowledgeConflicts.documentAId, docIds), inArray(knowledgeConflicts.documentBId, docIds))))) : [{ n: 0 }];
      const confidence = assessConfidence({ sources: passages as SourcePassage[], claims: verified, openConflicts: openConf?.n ?? 0, topRetrieval: topRelevance });
      const verificationFailed = verified.some((c) => c.important && (c.status === "UNSUPPORTED" || c.status === "CONTRADICTED"));
      const uncertaintyParts = [confidence.summary];
      if (relied.some((p) => p.freshness === "stale")) uncertaintyParts.push("Some sources are past their review date.");
      if ((openConf?.n ?? 0) > 0 && !/conflict/i.test(confidence.summary)) uncertaintyParts.push("Some cited documents have unresolved conflicts with other documents.");
      if (verified.some((c) => c.status === "UNSUPPORTED")) uncertaintyParts.push("Sentences marked unsupported are not stated in any source you can access.");
      const escalate = categories.filter((c) => c.escalateWhen === "always" || confidence.level === "low" || confidence.level === "insufficient");
      const retain = st.storeQuestions && (await organizations.settingsInternal(orgId)).dataRetention.aiPromptRetention !== "none";
      const status = escalate.length ? "escalated" : !passages.length ? "unanswered" : "answered";
      const cited = new Set(verified.flatMap((c) => c.cited));
      const response2 = response ?? (passages.length ? null : "No approved information that you can access answers this question.");

      const saved = await orgScope(orgId, async (tx) => {
        const [q] = await tx.insert(knowledgeQueries).values({
          organizationId: orgId, actorType: ctx.actor.type, actorId: ctx.actor.id, userId: who.userId, department: who.department, sourceModule: input.sourceModule ?? MODULE_ID,
          question: retain ? redactString(input.question) : null, normalized: retain ? normalizeQuestion(redactString(input.question)) : null, questionHash: sha256(input.question.trim().toLowerCase()),
          categories: categories.map((c) => c.key), status, retrievedCount: passages.length, topScore: Math.round(topRelevance * 10000) / 10000, latencyMs: Math.round(performance.now() - started),
        }).returning();
        const [a] = await tx.insert(knowledgeAnswers).values({
          organizationId: orgId, queryId: q!.id, response: retain ? response2 : null, mode: gen?.mode ?? "none", modeNote: gen?.note ?? null, aiRunId: gen?.runId ?? null, model: gen?.model ?? null,
          confidence: confidence.level, confidenceFactors: confidence.factors, confidenceSummary: confidence.summary, uncertainty: uncertaintyParts.join(" "), escalated: escalate.length > 0,
        }).returning();
        if (passages.length) await tx.insert(knowledgeCitations).values(passages.map((p) => ({ organizationId: orgId, answerId: a!.id, marker: p.marker, documentId: p.documentId, chunkId: p.chunkId, documentVersion: p.version, title: p.title, authority: p.authority, freshness: p.freshness, documentDate: p.documentDate ? new Date(p.documentDate) : null, score: p.score, cited: cited.has(p.marker) })));
        for (const c of verified) {
          const [cl] = await tx.insert(knowledgeClaims).values({ organizationId: orgId, answerId: a!.id, ordinal: c.ordinal, text: retain ? c.text : null, important: c.important, cited: c.cited }).returning();
          await tx.insert(knowledgeVerifications).values({ organizationId: orgId, claimId: cl!.id, status: c.status, explanation: retain ? c.explanation : c.explanation.replace(/"[^"]*"/g, '"…"'), supporting: c.supporting, contradicting: c.contradicting, coverage: Math.round(c.coverage * 10000) / 10000 });
        }
        let reviewId: string | null = null;
        if (escalate.length) {
          const cat = escalate[0]!;
          const rv = await openReview(tx, orgId, { kind: "escalation", title: `${escalate.map((c) => c.label).join(" / ")} question needs an expert`, detail: `${retain ? `Question: ${redactString(input.question).slice(0, 500)}\n` : ""}Confidence: ${confidence.level} — ${confidence.summary}`, dedupeKey: `escalation:${q!.id}`, queryId: q!.id, category: cat.key, assigneeUserId: cat.expertUserIds[0] ?? null });
          reviewId = rv?.id ?? null;
        }
        return { q: q!, a: a!, reviewId };
      });

      await bus.publish(ctx, "knowledge.answer.generated", { queryId: saved.q.id, answerId: saved.a.id, confidence: confidence.level, mode: gen?.mode ?? "none", sources: passages.length, sourceModule: input.sourceModule ?? MODULE_ID });
      if (verificationFailed) {
        await bus.publish(ctx, "knowledge.verification.failed", { queryId: saved.q.id, answerId: saved.a.id, unsupported: verified.filter((c) => c.status === "UNSUPPORTED").length, contradicted: verified.filter((c) => c.status === "CONTRADICTED").length });
        await record(ctx, "knowledge.verification_failed", "knowledge_answer", saved.a.id, { outcome: "failure", metadata: { queryId: saved.q.id, statuses: verified.map((c) => c.status) } });
      }
      if (saved.reviewId) {
        await bus.publish(ctx, "knowledge.review.required", { reviewId: saved.reviewId, kind: "escalation" });
        await record(ctx, "knowledge.question_escalated", "knowledge_query", saved.q.id, { metadata: { categories: escalate.map((c) => c.key), confidence: confidence.level } });
        for (const cat of escalate) await notifications.notify(ctx, { type: "knowledge.escalation", title: `${cat.label} question needs an expert (${confidence.level} confidence)`, body: retain ? redactString(input.question).slice(0, 300) : "A question was escalated.", actionUrl: `${BASE}/reviews?focus=${saved.reviewId}`, priority: cat.escalateWhen === "always" ? "high" : "normal", recipients: await escalationTargets(cat) });
      }
      await usage.record(ctx, { moduleId: MODULE_ID, metric: "knowledge.questions", unit: "question", quantity: 1, dimensions: { confidence: confidence.level, mode: gen?.mode ?? "none" } });

      return {
        queryId: saved.q.id, answerId: saved.a.id, question: input.question, response: response2, mode: gen?.mode ?? "none", modeNote: gen?.note ?? null,
        confidence: { level: confidence.level, summary: confidence.summary, factors: confidence.factors }, uncertainty: uncertaintyParts.join(" "),
        citations: passages.map((p) => ({ marker: p.marker, documentId: p.documentId, title: p.title, sourceName: p.sourceName, authority: p.authority, freshness: p.freshness, documentDate: p.documentDate, version: p.version, excerpt: p.text.slice(0, 500), cited: cited.has(p.marker), score: p.score })),
        claims: verified.map((c) => ({ text: c.text, important: c.important, cited: c.cited, status: c.status, explanation: c.explanation, supporting: c.supporting, contradicting: c.contradicting })),
        escalation: escalate.length ? { categories: escalate.map((c) => c.label), reviewId: saved.reviewId } : null,
        verificationFailed, createdAt: saved.q.createdAt.toISOString(), askedBy: ctx.actor.label,
      };
    },

    async listQueries(ctx: TenantContext, q: { status?: string; confidence?: string; mine?: boolean } = {}) {
      await authorizer.require(ctx, "knowledge.search");
      const all = !q.mine && (await authorizer.can(ctx, "knowledge.verification.read"));
      return tenant(ctx, async (tx) => {
        const rows = await tx.select({ q: knowledgeQueries, a: knowledgeAnswers, name: users.name }).from(knowledgeQueries).leftJoin(knowledgeAnswers, eq(knowledgeAnswers.queryId, knowledgeQueries.id)).leftJoin(users, eq(users.id, knowledgeQueries.userId))
          .where(and(eq(knowledgeQueries.organizationId, org(ctx)), all ? undefined : eq(knowledgeQueries.actorId, ctx.actor.id), q.status ? eq(knowledgeQueries.status, q.status as "answered") : undefined, q.confidence ? eq(knowledgeAnswers.confidence, q.confidence as "low") : undefined))
          .orderBy(desc(knowledgeQueries.createdAt)).limit(300);
        return rows.map(({ q: x, a, name }) => ({ id: x.id, question: x.question, status: x.status, categories: x.categories, sourceModule: x.sourceModule, askedBy: name ?? `${x.actorType}`, department: x.department, confidence: a?.confidence ?? null, mode: a?.mode ?? null, escalated: a?.escalated ?? false, retrievedCount: x.retrievedCount, createdAt: x.createdAt.toISOString() }));
      });
    },

    async getAnswer(ctx: TenantContext, queryId: string): Promise<AnswerView> {
      await authorizer.require(ctx, "knowledge.search");
      uuidOr404(queryId, "Question");
      const canAll = await authorizer.can(ctx, "knowledge.verification.read");
      const manage = await authorizer.can(ctx, "knowledge.manage");
      const { principals } = await callerPrincipals(ctx);
      return tenant(ctx, async (tx) => {
        const [row] = await tx.select({ q: knowledgeQueries, a: knowledgeAnswers, name: users.name }).from(knowledgeQueries).innerJoin(knowledgeAnswers, eq(knowledgeAnswers.queryId, knowledgeQueries.id)).leftJoin(users, eq(users.id, knowledgeQueries.userId)).where(and(eq(knowledgeQueries.organizationId, org(ctx)), eq(knowledgeQueries.id, queryId))).limit(1);
        if (!row || (!canAll && row.q.actorId !== ctx.actor.id)) throw notFound("Question", queryId);
        const cites = await tx.select({ c: knowledgeCitations, chunkText: knowledgeChunks.text, sourceName: knowledgeSources.name, p: knowledgePermissions.principals }).from(knowledgeCitations).leftJoin(knowledgeChunks, eq(knowledgeChunks.id, knowledgeCitations.chunkId)).leftJoin(knowledgeDocuments, eq(knowledgeDocuments.id, knowledgeCitations.documentId)).leftJoin(knowledgeSources, eq(knowledgeSources.id, knowledgeDocuments.sourceId)).leftJoin(knowledgePermissions, eq(knowledgePermissions.documentId, knowledgeCitations.documentId)).where(eq(knowledgeCitations.answerId, row.a.id)).orderBy(knowledgeCitations.marker);
        const claims = await tx.select({ c: knowledgeClaims, v: knowledgeVerifications }).from(knowledgeClaims).innerJoin(knowledgeVerifications, eq(knowledgeVerifications.claimId, knowledgeClaims.id)).where(eq(knowledgeClaims.answerId, row.a.id)).orderBy(knowledgeClaims.ordinal);
        const [rv] = await tx.select({ id: knowledgeReviews.id }).from(knowledgeReviews).where(eq(knowledgeReviews.queryId, queryId)).limit(1);
        // Someone else's answer is shown in full only if the viewer can access every document it drew on.
        const hidden = row.q.actorId !== ctx.actor.id && !manage && cites.some(({ p }) => !(p ?? []).some((x) => principals.includes(x)));
        const hide = <T>(v: T) => (hidden ? null : v);
        return {
          queryId, answerId: row.a.id, question: row.q.question, response: hidden ? null : row.a.response, hiddenReason: hidden ? "This answer drew on documents you cannot access, so its text is hidden. Confidence and verification statuses are still shown." : null, mode: row.a.mode, modeNote: row.a.modeNote,
          confidence: { level: row.a.confidence, summary: row.a.confidenceSummary, factors: row.a.confidenceFactors }, uncertainty: row.a.uncertainty,
          // Excerpts are shown only for documents the viewer can access now.
          citations: cites.map(({ c, chunkText, sourceName, p }) => {
            const ok = manage || (p ?? []).some((x) => principals.includes(x));
            return { marker: c.marker, documentId: ok ? c.documentId : null, title: ok ? c.title : "A document you cannot access", sourceName: ok ? sourceName : null, authority: c.authority, freshness: c.freshness, documentDate: ok ? iso(c.documentDate) : null, version: c.documentVersion, excerpt: ok && chunkText ? chunkText.slice(0, 500) : null, cited: c.cited, score: c.score };
          }),
          claims: claims.map(({ c, v }) => ({ text: hide(c.text), important: c.important, cited: c.cited, status: v.status, explanation: hidden ? v.explanation.replace(/"[^"]*"/g, '"…"') : v.explanation, supporting: v.supporting, contradicting: v.contradicting })),
          escalation: row.a.escalated ? { categories: row.q.categories, reviewId: rv?.id ?? null } : null,
          verificationFailed: claims.some(({ c, v }) => c.important && (v.status === "UNSUPPORTED" || v.status === "CONTRADICTED")), createdAt: row.q.createdAt.toISOString(), askedBy: row.name ?? row.q.actorType,
        };
      });
    },

    // ── Conflicts & reviews ───────────────────────────────────────────────
    async listConflicts(ctx: TenantContext, q: { status?: string } = {}) {
      await authorizer.require(ctx, "knowledge.conflict.review");
      return tenant(ctx, async (tx) => {
        const rows = await tx.select({ c: knowledgeConflicts, ta: sql<string>`(select title from knowledge_documents where id = ${knowledgeConflicts.documentAId})`, tb: sql<string>`(select title from knowledge_documents where id = ${knowledgeConflicts.documentBId})`, da: sql<Date | null>`(select coalesce(effective_date, last_modified_at) from knowledge_documents where id = ${knowledgeConflicts.documentAId})`, db: sql<Date | null>`(select coalesce(effective_date, last_modified_at) from knowledge_documents where id = ${knowledgeConflicts.documentBId})` })
          .from(knowledgeConflicts).where(and(eq(knowledgeConflicts.organizationId, org(ctx)), q.status ? eq(knowledgeConflicts.status, q.status as "open") : undefined)).orderBy(desc(sql`case ${knowledgeConflicts.kind} when 'contradiction' then 3 when 'newer_version' then 2 when 'near_duplicate' then 1 else 0 end`), desc(knowledgeConflicts.detectedAt)).limit(500);
        return rows.map(({ c, ta, tb, da, db: dbb }) => ({ id: c.id, kind: c.kind, status: c.status, similarity: c.similarity, newer: c.newer, detail: c.detail, evidence: c.evidence, resolution: c.resolution, resolutionNote: c.resolutionNote, documentA: { id: c.documentAId, title: ta, date: da ? new Date(da).toISOString() : null }, documentB: { id: c.documentBId, title: tb, date: dbb ? new Date(dbb).toISOString() : null }, detectedAt: c.detectedAt.toISOString(), reviewedAt: iso(c.reviewedAt) }));
      });
    },

    /** A reviewer decides. keep_a / keep_b supersede the other document (it stops being used in answers). */
    async resolveConflict(ctx: TenantContext, id: string, raw: unknown) {
      await authorizer.require(ctx, "knowledge.conflict.review");
      if (ctx.actor.type !== "user") throw forbidden("Conflicts are resolved by people.");
      const input = parse(z.object({ resolution: z.enum(["keep_a", "keep_b", "both_valid", "not_a_conflict"]), note: text(2000).optional() }), raw);
      uuidOr404(id, "Conflict");
      const c = await tenant(ctx, async (tx) => {
        const [x] = await tx.select().from(knowledgeConflicts).where(and(eq(knowledgeConflicts.organizationId, org(ctx)), eq(knowledgeConflicts.id, id))).limit(1);
        if (!x) throw notFound("Conflict", id);
        if (x.status !== "open") throw conflict(`This conflict is already ${x.status}.`);
        const [u] = await tx.update(knowledgeConflicts).set({ status: input.resolution === "not_a_conflict" ? "dismissed" : "resolved", resolution: input.resolution, resolutionNote: input.note ?? null, reviewedBy: userId(ctx), reviewedAt: new Date() }).where(eq(knowledgeConflicts.id, id)).returning();
        if (input.resolution === "keep_a" || input.resolution === "keep_b") {
          const [keep, drop] = input.resolution === "keep_a" ? [x.documentAId, x.documentBId] : [x.documentBId, x.documentAId];
          await tx.update(knowledgeDocuments).set({ status: "superseded", supersededByDocumentId: keep, updatedAt: new Date() }).where(eq(knowledgeDocuments.id, drop));
        }
        await tx.update(knowledgeReviews).set({ status: "resolved", resolution: `${input.resolution.replace("_", " ")}${input.note ? `: ${input.note}` : ""}`, resolvedBy: userId(ctx), resolvedAt: new Date(), updatedAt: new Date() }).where(eq(knowledgeReviews.conflictId, id));
        return u!;
      });
      await record(ctx, "knowledge.conflict_resolved", "knowledge_conflict", id, { after: { resolution: input.resolution, note: input.note }, metadata: { kind: c.kind, documentAId: c.documentAId, documentBId: c.documentBId } });
      if (input.resolution === "keep_a" || input.resolution === "keep_b") await refreshIndexStats(org(ctx));
      return { id, status: c.status, resolution: c.resolution };
    },

    async listReviews(ctx: TenantContext, q: { status?: string; kind?: string } = {}) {
      if (!(await authorizer.can(ctx, "knowledge.conflict.review"))) await authorizer.require(ctx, "knowledge.manage");
      return tenant(ctx, async (tx) => {
        const rows = await tx.select({ r: knowledgeReviews, assignee: users.name, docTitle: knowledgeDocuments.title }).from(knowledgeReviews).leftJoin(users, eq(users.id, knowledgeReviews.assigneeUserId)).leftJoin(knowledgeDocuments, eq(knowledgeDocuments.id, knowledgeReviews.documentId))
          .where(and(eq(knowledgeReviews.organizationId, org(ctx)), q.status === "active" || !q.status ? inArray(knowledgeReviews.status, ["open", "in_progress"]) : eq(knowledgeReviews.status, q.status as "open"), q.kind ? eq(knowledgeReviews.kind, q.kind as ReviewKind) : undefined))
          .orderBy(desc(sql`case ${knowledgeReviews.kind} when 'escalation' then 5 when 'conflict' then 4 when 'expired' then 3 when 'review_due' then 2 when 'stale' then 1 else 0 end`), desc(knowledgeReviews.createdAt)).limit(1000);
        return rows.map(({ r, assignee, docTitle }) => ({ id: r.id, kind: r.kind, title: r.title, detail: r.detail, status: r.status, category: r.category, documentId: r.documentId, documentTitle: docTitle, queryId: r.queryId, conflictId: r.conflictId, assigneeUserId: r.assigneeUserId, assignee, resolution: r.resolution, resolvedAt: iso(r.resolvedAt), createdAt: r.createdAt.toISOString() }));
      });
    },

    async updateReview(ctx: TenantContext, id: string, raw: unknown) {
      if (!(await authorizer.can(ctx, "knowledge.conflict.review"))) await authorizer.require(ctx, "knowledge.manage");
      const input = parse(z.object({ status: z.enum(["open", "in_progress", "resolved", "dismissed"]).optional(), assigneeUserId: z.string().uuid().nullish(), resolution: text(4000).optional() }), raw);
      uuidOr404(id, "Review");
      const r = await tenant(ctx, async (tx) => {
        const [x] = await tx.select().from(knowledgeReviews).where(and(eq(knowledgeReviews.organizationId, org(ctx)), eq(knowledgeReviews.id, id))).limit(1);
        if (!x) throw notFound("Review", id);
        if (x.kind === "conflict" && (input.status === "resolved" || input.status === "dismissed")) throw new AppError("VALIDATION_FAILED", "Resolve the conflict itself (keep one, both valid, or not a conflict).");
        if (input.status === "resolved" && x.kind === "escalation" && !(input.resolution ?? x.resolution)) throw new AppError("VALIDATION_FAILED", "Write the expert answer before resolving an escalation.");
        await assertMember(tx, org(ctx), input.assigneeUserId, "Assignee");
        const done = input.status === "resolved" || input.status === "dismissed";
        const [u] = await tx.update(knowledgeReviews).set({ ...input, ...(done ? { resolvedBy: userId(ctx), resolvedAt: new Date() } : {}), updatedAt: new Date() }).where(eq(knowledgeReviews.id, id)).returning();
        const [q] = x.queryId ? await tx.select({ userId: knowledgeQueries.userId }).from(knowledgeQueries).where(eq(knowledgeQueries.id, x.queryId)).limit(1) : [];
        return { before: x, after: u!, askerId: q?.userId ?? null };
      });
      await record(ctx, "knowledge.review_updated", "knowledge_review", id, { before: { status: r.before.status, assigneeUserId: r.before.assigneeUserId }, after: input });
      if (r.after.kind === "escalation" && input.status === "resolved" && r.askerId) await notifications.notify(ctx, { type: "knowledge.escalation", title: "An expert answered your question", body: (input.resolution ?? r.after.resolution ?? "").slice(0, 400), actionUrl: `${BASE}/history/${r.after.queryId}`, recipients: { userIds: [r.askerId] } });
      if (input.assigneeUserId && input.assigneeUserId !== r.before.assigneeUserId) await notifications.notify(ctx, { type: "knowledge.review_required", title: `Assigned to you: ${r.after.title}`, body: r.after.detail.slice(0, 300), actionUrl: `${BASE}/reviews?focus=${id}`, recipients: { userIds: [input.assigneeUserId] } });
      return { id, status: r.after.status };
    },

    async runFreshnessScan(ctx: TenantContext) {
      await authorizer.require(ctx, "knowledge.manage");
      const n = await freshnessFor(org(ctx));
      await record(ctx, "knowledge.freshness_scan", "knowledge_review", org(ctx), { metadata: { created: n } });
      return { created: n };
    },

    // ── Analytics ─────────────────────────────────────────────────────────
    async analytics(ctx: TenantContext) {
      await authorizer.require(ctx, "knowledge.verification.read");
      const st = await settings(org(ctx));
      const now = new Date();
      const since = new Date(Date.now() - 30 * 86400_000);
      return tenant(ctx, async (tx) => {
        const o = org(ctx);
        const inWindow = and(eq(knowledgeQueries.organizationId, o), gte(knowledgeQueries.createdAt, since));
        const top = await tx.select({ q: knowledgeQueries.normalized, sample: sql<string>`min(${knowledgeQueries.question})`, n: sql<number>`count(*)::int` }).from(knowledgeQueries).where(and(inWindow, sql`${knowledgeQueries.normalized} is not null and ${knowledgeQueries.normalized} <> ''`)).groupBy(knowledgeQueries.normalized).orderBy(desc(sql`3`)).limit(10);
        const unanswered = await tx.select({ id: knowledgeQueries.id, q: knowledgeQueries.question, at: knowledgeQueries.createdAt }).from(knowledgeQueries).where(and(inWindow, eq(knowledgeQueries.status, "unanswered"))).orderBy(desc(knowledgeQueries.createdAt)).limit(10);
        const lowConf = await tx.select({ id: knowledgeQueries.id, q: knowledgeQueries.question, c: knowledgeAnswers.confidence, at: knowledgeQueries.createdAt }).from(knowledgeQueries).innerJoin(knowledgeAnswers, eq(knowledgeAnswers.queryId, knowledgeQueries.id)).where(and(inWindow, inArray(knowledgeAnswers.confidence, ["low", "insufficient"]))).orderBy(desc(knowledgeQueries.createdAt)).limit(10);
        const cited = await tx.select({ id: knowledgeCitations.documentId, title: sql<string>`min(${knowledgeCitations.title})`, n: sql<number>`count(*)::int` }).from(knowledgeCitations).where(and(eq(knowledgeCitations.organizationId, o), eq(knowledgeCitations.cited, true), gte(knowledgeCitations.createdAt, since))).groupBy(knowledgeCitations.documentId).orderBy(desc(sql`3`)).limit(10);
        const conf = await tx.select({ c: knowledgeAnswers.confidence, n: sql<number>`count(*)::int` }).from(knowledgeAnswers).innerJoin(knowledgeQueries, eq(knowledgeQueries.id, knowledgeAnswers.queryId)).where(inWindow).groupBy(knowledgeAnswers.confidence);
        const verif = await tx.select({ s: knowledgeVerifications.status, n: sql<number>`count(*)::int` }).from(knowledgeVerifications).where(and(eq(knowledgeVerifications.organizationId, o), gte(knowledgeVerifications.createdAt, since))).groupBy(knowledgeVerifications.status);
        const byDept = await tx.select({ d: sql<string>`coalesce(${knowledgeQueries.department}, case when ${knowledgeQueries.sourceModule} = ${MODULE_ID} then 'No department' else ${knowledgeQueries.sourceModule} || ' (module)' end)`, n: sql<number>`count(*)::int` }).from(knowledgeQueries).where(inWindow).groupBy(sql`1`).orderBy(desc(sql`2`)).limit(12);
        const docs = await tx.select({ d: knowledgeDocuments, staleDays: knowledgeSources.staleDays }).from(knowledgeDocuments).innerJoin(knowledgeSources, eq(knowledgeSources.id, knowledgeDocuments.sourceId)).where(and(eq(knowledgeDocuments.organizationId, o), eq(knowledgeDocuments.status, "active")));
        const fresh = { fresh: 0, stale: 0, expired: 0, noOwner: 0 };
        for (const { d, staleDays } of docs) {
          const f = freshnessOf(d, now, staleDays ?? st.staleDays);
          fresh[f]++;
          if (!d.ownerUserId) fresh.noOwner++;
        }
        const [conflicts] = await tx.select({ open: sql<number>`count(*) filter (where ${knowledgeConflicts.status} = 'open')::int`, contradictions: sql<number>`count(*) filter (where ${knowledgeConflicts.status} = 'open' and ${knowledgeConflicts.kind} = 'contradiction')::int` }).from(knowledgeConflicts).where(eq(knowledgeConflicts.organizationId, o));
        const [totals] = await tx.select({ n: sql<number>`count(*)::int`, escalated: sql<number>`count(*) filter (where ${knowledgeQueries.status} = 'escalated')::int` }).from(knowledgeQueries).where(inWindow);
        // Knowledge gaps: terms that recur in questions with no or weak support.
        const gapRows = await tx.select({ q: knowledgeQueries.normalized }).from(knowledgeQueries).leftJoin(knowledgeAnswers, eq(knowledgeAnswers.queryId, knowledgeQueries.id)).where(and(inWindow, or(eq(knowledgeQueries.status, "unanswered"), inArray(knowledgeAnswers.confidence, ["low", "insufficient"])), sql`${knowledgeQueries.normalized} is not null`)).limit(2000);
        // Counted by stem, shown as the first word form seen ("employees", not "employe").
        const gapTerms = new Map<string, number>();
        const gapLabel = new Map<string, string>();
        for (const g of gapRows) {
          const seen = new Set<string>();
          for (const w of words(g.q ?? "")) {
            const t = terms(w)[0];
            if (!t || /^\d/.test(t) || t.length <= 3 || seen.has(t)) continue;
            seen.add(t);
            if (!gapLabel.has(t)) gapLabel.set(t, w);
            gapTerms.set(t, (gapTerms.get(t) ?? 0) + 1);
          }
        }
        return {
          totals: { questions30d: totals?.n ?? 0, escalated30d: totals?.escalated ?? 0, documents: docs.length, ...fresh, openConflicts: conflicts?.open ?? 0, contradictions: conflicts?.contradictions ?? 0 },
          topQuestions: top.map((t) => ({ question: t.sample ?? t.q, count: t.n })),
          unanswered: unanswered.map((u) => ({ queryId: u.id, question: u.q, at: u.at.toISOString() })),
          lowConfidence: lowConf.map((u) => ({ queryId: u.id, question: u.q, confidence: u.c, at: u.at.toISOString() })),
          frequentlyCited: cited.map((c) => ({ documentId: c.id, title: c.title, count: c.n })),
          confidence: ["high", "medium", "low", "insufficient"].map((l) => ({ label: l, value: conf.find((c) => c.c === l)?.n ?? 0 })),
          verification: ["VERIFIED", "PARTIALLY_VERIFIED", "UNSUPPORTED", "CONTRADICTED"].map((l) => ({ label: l.replace("_", " ").toLowerCase(), value: verif.find((v) => v.s === l)?.n ?? 0 })),
          byDepartment: byDept.map((d) => ({ label: d.d ?? "Unknown", value: d.n })),
          gaps: [...gapTerms.entries()].filter(([, n]) => n >= 1).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([term, count]) => ({ term: gapLabel.get(term) ?? term, count })),
          questionTextRetained: st.storeQuestions,
        };
      });
    },

    // ── Internal ──────────────────────────────────────────────────────────
    async freshnessAll() {
      const orgs = await db.withSystem("knowledge.freshness", (tx) => tx.execute(sql`select distinct organization_id from knowledge_documents where status = 'active'`));
      for (const r of orgs.rows as Array<{ organization_id: string }>) {
        if (await modules.isEnabled(r.organization_id, MODULE_ID)) await freshnessFor(r.organization_id).catch((e: unknown) => logger.warn("knowledge.freshness_failed", { error: e instanceof Error ? e.message : String(e) }));
      }
    },
    async applyRetention() {
      await db.withSystem("knowledge.retention", (tx) => tx.execute(sql`delete from knowledge_queries q using organization_settings s where s.organization_id = q.organization_id and q.created_at < now() - make_interval(days => coalesce((s.data_retention->>'aiRunDays')::int, 365)) and not exists (select 1 from knowledge_reviews r where r.query_id = q.id and r.status in ('open', 'in_progress'))`));
    },
    /** Global search: titles of documents the caller may retrieve. */
    async searchTitles(ctx: TenantContext, q: string, limit: number) {
      const { principals } = await callerPrincipals(ctx);
      if (!principals.length) return [];
      const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      return tenant(ctx, (tx) => tx.select({ id: knowledgeDocuments.id, title: knowledgeDocuments.title, authority: knowledgeDocuments.authority, classification: knowledgeDocuments.classification }).from(knowledgeDocuments).innerJoin(knowledgePermissions, eq(knowledgePermissions.documentId, knowledgeDocuments.id))
        .where(and(eq(knowledgeDocuments.organizationId, org(ctx)), eq(knowledgeDocuments.status, "active"), sql`${knowledgeDocuments.title} ilike ${like}`, sql`${knowledgePermissions.principals} && ${pgTextArray(principals)}::text[]`)).limit(limit));
    },
  };

  return service;
}


