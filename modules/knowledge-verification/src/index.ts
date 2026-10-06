import { z } from "zod";
import { type ModuleManifest } from "@eaop/module-registry";
import { type ModuleDefinition, type Platform } from "@eaop/platform";
import { textScore } from "@eaop/search";
import { createKnowledgeService, FRESHNESS_JOB, MODULE_ID, RETENTION_JOB, SYNC_JOB, type KnowledgeApi, type KnowledgeService } from "./service";

export * from "./service";
export * from "./extract";
export * from "./text";
export * from "./conflicts";
export * from "./verify";
export * from "./rank";
export * from "./indexing";
export { REVIEW_KINDS, type AclEntry } from "./schema";

const id = z.string().uuid();
const ev = <S extends z.ZodTypeAny>(type: string, description: string, schema: S) => ({ type, owner: MODULE_ID, version: 1, description, schema });
const docPayload = z.object({ documentId: id, sourceId: id, version: z.number().int(), chunkCount: z.number().int() });

export const KNOWLEDGE_EVENTS = [
  ev("knowledge.document.ingested", "A new document was ingested and indexed.", docPayload),
  ev("knowledge.document.updated", "A new version of an existing document was ingested.", docPayload),
  ev("knowledge.conflict.detected", "A duplicate, near duplicate, newer version or contradiction was found between two documents.", z.object({ conflictId: id, kind: z.string(), documentAId: id, documentBId: id })),
  ev("knowledge.review.required", "Documents or an answer were added to a review queue (freshness, conflict or expert escalation).", z.object({ reviewId: id, kind: z.string() })),
  ev("knowledge.answer.generated", "A cited answer was produced. No question text is included.", z.object({ queryId: id, answerId: id, confidence: z.string(), mode: z.string(), sources: z.number().int(), sourceModule: z.string() })),
  ev("knowledge.verification.failed", "An answer contained unsupported or contradicted claims.", z.object({ queryId: id, answerId: id, unsupported: z.number().int(), contradicted: z.number().int() })),
];

const ALL = ["knowledge.read", "knowledge.search", "knowledge.ingest", "knowledge.manage", "knowledge.source.manage", "knowledge.conflict.review", "knowledge.verification.read", "knowledge.admin"];

export const manifest: ModuleManifest = {
  id: MODULE_ID,
  name: "AI Knowledge & Verification",
  shortName: "Knowledge",
  description: "Trusted, permission-aware enterprise knowledge layer with citations, claim verification and confidence.",
  version: "1.0.0",
  installStatus: "installed",
  icon: "BookCheck",
  basePath: "/m/knowledge-verification",
  entryPermission: "knowledge.read",
  permissions: [
    { key: "knowledge.read", description: "Open the knowledge module and see documents you are permitted to read.", risk: "low" },
    { key: "knowledge.search", description: "Ask questions and retrieve passages (only from documents you are permitted to read).", risk: "low" },
    { key: "knowledge.ingest", description: "Upload documents and new versions to sources.", risk: "medium" },
    { key: "knowledge.manage", description: "Manage all documents: metadata, authority, permissions, freshness reviews and the full document list.", risk: "high" },
    { key: "knowledge.source.manage", description: "Create and configure knowledge sources and run connector syncs.", risk: "high" },
    { key: "knowledge.conflict.review", description: "Review duplicates, contradictions and expert escalations.", risk: "medium" },
    { key: "knowledge.verification.read", description: "See every question and its verification across the organization (answer text only where the viewer can access the sources), plus analytics.", risk: "medium" },
    { key: "knowledge.admin", description: "Change module settings: staleness, question retention and escalation categories and experts.", risk: "high" },
  ],
  roleGrants: {
    ai_admin: ALL.filter((p) => p !== "knowledge.conflict.review"),
    security_admin: ["knowledge.read", "knowledge.search", "knowledge.verification.read", "knowledge.conflict.review"],
    department_leader: ["knowledge.read", "knowledge.search", "knowledge.ingest", "knowledge.conflict.review", "knowledge.verification.read"],
    analyst: ["knowledge.read", "knowledge.search", "knowledge.ingest"],
    standard_user: ["knowledge.read", "knowledge.search"],
    read_only: ["knowledge.read"],
    auditor: ["knowledge.read", "knowledge.verification.read"],
  },
  events: KNOWLEDGE_EVENTS,
  notificationTypes: [
    { key: "knowledge.conflict", description: "Contradictory documents were found and need a reviewer.", defaultPriority: "high", channels: ["in_app", "email"] },
    { key: "knowledge.review_required", description: "Documents are stale, expired or ownerless, or a review was assigned to you.", defaultPriority: "normal", channels: ["in_app"] },
    { key: "knowledge.escalation", description: "A question in your area needs an expert, or an expert answered your question.", defaultPriority: "high", channels: ["in_app", "email"] },
  ],
  navigation: [
    { label: "Ask", href: "/", permission: "knowledge.search" },
    { label: "History", href: "/history", permission: "knowledge.verification.read" },
    { label: "Documents", href: "/documents", permission: "knowledge.read" },
    { label: "Sources", href: "/sources", permission: "knowledge.read" },
    { label: "Review queues", href: "/reviews", permission: "knowledge.conflict.review" },
    { label: "Analytics", href: "/analytics", permission: "knowledge.verification.read" },
    { label: "Settings", href: "/settings", permission: "knowledge.admin" },
  ],
};

/** Installed module: service, sync/freshness/retention jobs and document search on the SHARED core. */
export const knowledgeVerification: ModuleDefinition = {
  manifest,
  install(platform: Platform) {
    const service = createKnowledgeService({
      db: platform.db, authorizer: platform.rbac.authorizer, audit: platform.audit, bus: platform.events.bus, notifications: platform.notifications, ai: platform.ai,
      connectors: platform.connectors, jobs: platform.jobs, organizations: platform.organizations, usage: platform.usage, modules: platform.modules, logger: platform.logger,
    });
    platform.moduleServices.set(MODULE_ID, service);

    platform.jobs.register({
      type: SYNC_JOB,
      maxAttempts: 1,
      timeoutMs: 30 * 60_000,
      async handle(job) {
        const { sourceId } = job.payload as { sourceId: string };
        if (job.organizationId && (await platform.modules.isEnabled(job.organizationId, MODULE_ID))) await service.runSync(job.organizationId, sourceId);
      },
    });
    platform.jobs.register({ type: FRESHNESS_JOB, maxAttempts: 2, timeoutMs: 30 * 60_000, handle: () => service.freshnessAll() });
    platform.jobs.register({ type: RETENTION_JOB, maxAttempts: 3, timeoutMs: 30 * 60_000, handle: () => service.applyRetention() });

    platform.search.register({
      resourceType: "knowledge_document",
      owner: MODULE_ID,
      label: "Knowledge documents",
      permission: "knowledge.read",
      async search(ctx, q, limit) {
        const rows = await service.searchTitles(ctx, q, limit);
        return rows.map((d) => ({ resourceType: "knowledge_document", id: d.id, title: d.title, subtitle: `Knowledge · ${d.authority ?? "source authority"} · ${d.classification}`, url: `/m/knowledge-verification/documents/${d.id}`, score: textScore(q, d.title) }));
      },
    });
  },
};

/** Typed accessor for apps — throws if the module is not installed. */
export function knowledgeService(platform: Pick<Platform, "moduleServices">): KnowledgeService {
  const s = platform.moduleServices.get(MODULE_ID) as KnowledgeService | undefined;
  if (!s) throw new Error("AI Knowledge & Verification module is not installed");
  return s;
}

/** The stable API for other modules: permission-aware retrieval, cited answers and document metadata. */
export function knowledgeApi(platform: Pick<Platform, "moduleServices">): KnowledgeApi | null {
  return (platform.moduleServices.get(MODULE_ID) as KnowledgeApi | undefined) ?? null;
}

export default manifest;
