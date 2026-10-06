import { boolean, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { connectors, organizations, users } from "@eaop/db";
import { type EscalationCategory } from "./rank";
import { type Authority, type ConfidenceFactor, type ConfidenceLevel, type VerificationStatus } from "./verify";

/**
 * Drizzle mirror of migrations/0001_knowledge_verification.sql (the SQL is
 * the source of truth; it also defines the generated `tsv` column used by the
 * default index provider and enables tenant RLS).
 */

const id = () => uuid("id").primaryKey().defaultRandom();
const org = () => uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date", precision: 3 });
const userRef = (name: string) => uuid(name).references(() => users.id, { onDelete: "set null" });
const num = (name: string, precision: number, scale: number) => numeric(name, { precision, scale, mode: "number" });

export type Classification = "public" | "internal" | "confidential" | "restricted";

export const knowledgeSettings = pgTable("knowledge_settings", {
  organizationId: uuid("organization_id").primaryKey().references(() => organizations.id, { onDelete: "cascade" }),
  staleDays: integer("stale_days").notNull().default(365),
  reviewIntervalDays: integer("review_interval_days").notNull().default(365),
  storeQuestions: boolean("store_questions").notNull().default(true),
  escalationCategories: jsonb("escalation_categories").$type<EscalationCategory[] | null>(),
  updatedBy: userRef("updated_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const knowledgeIndexes = pgTable("knowledge_indexes", {
  id: id(),
  organizationId: org(),
  name: text("name").notNull(),
  provider: text("provider").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  status: text("status").$type<"ready" | "building" | "failed">().notNull().default("ready"),
  documentCount: integer("document_count").notNull().default(0),
  chunkCount: integer("chunk_count").notNull().default(0),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  lastBuiltAt: ts("last_built_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const knowledgeSources = pgTable("knowledge_sources", {
  id: id(),
  organizationId: org(),
  name: text("name").notNull(),
  kind: text("kind").$type<"upload" | "connector" | "api">().notNull(),
  connectorId: uuid("connector_id").references(() => connectors.id, { onDelete: "set null" }),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  authority: text("authority").$type<Authority>().notNull().default("secondary"),
  ownerUserId: userRef("owner_user_id"),
  department: text("department"),
  classification: text("classification").$type<Classification>().notNull().default("internal"),
  defaultPrincipals: text("default_principals").array().notNull().default(["org:*"]),
  staleDays: integer("stale_days"),
  status: text("status").$type<"active" | "paused">().notNull().default("active"),
  lastSyncAt: ts("last_sync_at"),
  lastSyncStatus: text("last_sync_status").$type<"queued" | "running" | "succeeded" | "failed" | null>(),
  lastSyncMessage: text("last_sync_message"),
  createdBy: userRef("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const knowledgeDocuments = pgTable("knowledge_documents", {
  id: id(),
  organizationId: org(),
  sourceId: uuid("source_id").notNull().references(() => knowledgeSources.id, { onDelete: "cascade" }),
  externalId: text("external_id").notNull(),
  title: text("title").notNull(),
  format: text("format").notNull(),
  sourceUrl: text("source_url"),
  ownerUserId: userRef("owner_user_id"),
  ownerLabel: text("owner_label"),
  department: text("department"),
  classification: text("classification").$type<Classification>().notNull().default("internal"),
  authority: text("authority").$type<Authority | null>(),
  status: text("status").$type<"active" | "superseded" | "archived">().notNull().default("active"),
  ingestionStatus: text("ingestion_status").$type<"pending" | "processing" | "indexed" | "failed">().notNull().default("pending"),
  ingestionError: text("ingestion_error"),
  ingestionWarnings: text("ingestion_warnings").array().notNull().default([]),
  currentVersion: integer("current_version").notNull().default(0),
  contentHash: text("content_hash"),
  signature: integer("signature").array().notNull().default([]),
  charCount: integer("char_count").notNull().default(0),
  chunkCount: integer("chunk_count").notNull().default(0),
  effectiveDate: ts("effective_date"),
  expirationDate: ts("expiration_date"),
  reviewDueAt: ts("review_due_at"),
  lastReviewedAt: ts("last_reviewed_at"),
  lastModifiedAt: ts("last_modified_at"),
  supersededByDocumentId: uuid("superseded_by_document_id"),
  createdBy: userRef("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const knowledgeDocumentVersions = pgTable("knowledge_document_versions", {
  id: id(),
  organizationId: org(),
  documentId: uuid("document_id").notNull().references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  contentHash: text("content_hash").notNull(),
  charCount: integer("char_count").notNull(),
  chunkCount: integer("chunk_count").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  changeSummary: text("change_summary").notNull().default(""),
  ingestedBy: text("ingested_by").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const knowledgeChunks = pgTable("knowledge_chunks", {
  id: id(),
  organizationId: org(),
  documentId: uuid("document_id").notNull().references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  ordinal: integer("ordinal").notNull(),
  heading: text("heading"),
  text: text("text").notNull(),
  startOffset: integer("start_offset").notNull(),
  endOffset: integer("end_offset").notNull(),
  contentHash: text("content_hash").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export interface AclEntry { type: string; id?: string; name?: string; email?: string }

export const knowledgePermissions = pgTable("knowledge_permissions_metadata", {
  id: id(),
  organizationId: org(),
  documentId: uuid("document_id").notNull().references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
  mode: text("mode").$type<"source_default" | "source_acl" | "explicit">().notNull(),
  rawAcl: jsonb("raw_acl").$type<AclEntry[]>().notNull().default([]),
  principals: text("principals").array().notNull().default([]),
  unmapped: jsonb("unmapped").$type<AclEntry[]>().notNull().default([]),
  updatedBy: text("updated_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const knowledgeConflicts = pgTable("knowledge_conflicts", {
  id: id(),
  organizationId: org(),
  kind: text("kind").$type<"duplicate" | "near_duplicate" | "newer_version" | "contradiction">().notNull(),
  documentAId: uuid("document_a_id").notNull().references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
  documentBId: uuid("document_b_id").notNull().references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
  similarity: num("similarity", 5, 4).notNull().default(0),
  newer: text("newer").$type<"a" | "b" | null>(),
  detail: text("detail").notNull(),
  evidence: jsonb("evidence").$type<Array<{ a: string; b: string; reason: string }>>().notNull().default([]),
  status: text("status").$type<"open" | "resolved" | "dismissed">().notNull().default("open"),
  resolution: text("resolution").$type<"keep_a" | "keep_b" | "both_valid" | "not_a_conflict" | null>(),
  resolutionNote: text("resolution_note"),
  reviewedBy: userRef("reviewed_by"),
  reviewedAt: ts("reviewed_at"),
  detectedAt: ts("detected_at").notNull().defaultNow(),
});

export const knowledgeQueries = pgTable("knowledge_queries", {
  id: id(),
  organizationId: org(),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id").notNull(),
  userId: userRef("user_id"),
  department: text("department"),
  sourceModule: text("source_module").notNull().default("knowledge_verification"),
  question: text("question"),
  normalized: text("normalized"),
  questionHash: text("question_hash").notNull(),
  categories: text("categories").array().notNull().default([]),
  status: text("status").$type<"answered" | "unanswered" | "escalated" | "failed">().notNull(),
  retrievedCount: integer("retrieved_count").notNull().default(0),
  topScore: num("top_score", 6, 4).notNull().default(0),
  latencyMs: integer("latency_ms").notNull().default(0),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const knowledgeAnswers = pgTable("knowledge_answers", {
  id: id(),
  organizationId: org(),
  queryId: uuid("query_id").notNull().references(() => knowledgeQueries.id, { onDelete: "cascade" }),
  response: text("response"),
  mode: text("mode").$type<"generative" | "extractive" | "none">().notNull(),
  modeNote: text("mode_note"),
  aiRunId: uuid("ai_run_id"),
  model: text("model"),
  confidence: text("confidence").$type<ConfidenceLevel>().notNull(),
  confidenceFactors: jsonb("confidence_factors").$type<ConfidenceFactor[]>().notNull().default([]),
  confidenceSummary: text("confidence_summary").notNull(),
  uncertainty: text("uncertainty"),
  escalated: boolean("escalated").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const knowledgeCitations = pgTable("knowledge_citations", {
  id: id(),
  organizationId: org(),
  answerId: uuid("answer_id").notNull().references(() => knowledgeAnswers.id, { onDelete: "cascade" }),
  marker: text("marker").notNull(),
  documentId: uuid("document_id").references(() => knowledgeDocuments.id, { onDelete: "set null" }),
  chunkId: uuid("chunk_id").references(() => knowledgeChunks.id, { onDelete: "set null" }),
  documentVersion: integer("document_version").notNull(),
  title: text("title").notNull(),
  authority: text("authority").$type<Authority>().notNull(),
  freshness: text("freshness").notNull(),
  documentDate: ts("document_date"),
  score: num("score", 6, 4).notNull(),
  cited: boolean("cited").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const knowledgeClaims = pgTable("knowledge_claims", {
  id: id(),
  organizationId: org(),
  answerId: uuid("answer_id").notNull().references(() => knowledgeAnswers.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  text: text("text"),
  important: boolean("important").notNull().default(false),
  cited: text("cited").array().notNull().default([]),
});

export const knowledgeVerifications = pgTable("knowledge_verifications", {
  id: id(),
  organizationId: org(),
  claimId: uuid("claim_id").notNull().references(() => knowledgeClaims.id, { onDelete: "cascade" }),
  status: text("status").$type<VerificationStatus>().notNull(),
  explanation: text("explanation").notNull(),
  supporting: text("supporting").array().notNull().default([]),
  contradicting: text("contradicting").array().notNull().default([]),
  coverage: num("coverage", 5, 4).notNull().default(0),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const REVIEW_KINDS = ["escalation", "stale", "expired", "no_owner", "review_due", "conflict"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export const knowledgeReviews = pgTable("knowledge_reviews", {
  id: id(),
  organizationId: org(),
  kind: text("kind").$type<ReviewKind>().notNull(),
  documentId: uuid("document_id").references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
  queryId: uuid("query_id").references(() => knowledgeQueries.id, { onDelete: "cascade" }),
  conflictId: uuid("conflict_id").references(() => knowledgeConflicts.id, { onDelete: "cascade" }),
  category: text("category"),
  title: text("title").notNull(),
  detail: text("detail").notNull().default(""),
  status: text("status").$type<"open" | "in_progress" | "resolved" | "dismissed">().notNull().default("open"),
  assigneeUserId: userRef("assignee_user_id"),
  resolution: text("resolution"),
  resolvedBy: userRef("resolved_by"),
  resolvedAt: ts("resolved_at"),
  dedupeKey: text("dedupe_key").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
