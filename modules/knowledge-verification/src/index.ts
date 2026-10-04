import { type ModuleManifest } from "@eaop/module-registry";

/**
 * PLACEHOLDER manifest for AI Knowledge & Verification.
 *
 * The module is not implemented yet. This manifest reserves its identity,
 * route prefix, permission keys and navigation so the shared core can show it
 * in the catalog as "Module not yet installed". It cannot be enabled until
 * installStatus is "installed".
 *
 * When the module is built (see docs/MODULE-SYSTEM.md → "Adding the first
 * module"), flip installStatus, add event contracts with real payload
 * schemas, notification types, search providers and module migrations.
 */
export const RESERVED_EVENT_TYPES = [
  "knowledge.document.ingested",
  "knowledge.document.updated",
  "knowledge.conflict.detected",
  "knowledge.review.required",
  "knowledge.answer.generated",
  "knowledge.verification.failed",
] as const;

export const manifest: ModuleManifest = {
  id: "knowledge_verification",
  name: "AI Knowledge & Verification",
  shortName: "Knowledge",
  description: "Trusted, permission-aware enterprise knowledge layer with citations, claim verification and confidence.",
  version: "0.0.0",
  installStatus: "not_installed",
  icon: "BookCheck",
  basePath: "/m/knowledge-verification",
  entryPermission: "knowledge.read",
  permissions: [
    { key: "knowledge.read", description: "knowledge.read (reserved — defined by the AI Knowledge & Verification module).", risk: "low" },
    { key: "knowledge.search", description: "knowledge.search (reserved — defined by the AI Knowledge & Verification module).", risk: "low" },
    { key: "knowledge.ingest", description: "knowledge.ingest (reserved — defined by the AI Knowledge & Verification module).", risk: "low" },
    { key: "knowledge.manage", description: "knowledge.manage (reserved — defined by the AI Knowledge & Verification module).", risk: "high" },
    { key: "knowledge.source.manage", description: "knowledge.source.manage (reserved — defined by the AI Knowledge & Verification module).", risk: "high" },
    { key: "knowledge.conflict.review", description: "knowledge.conflict.review (reserved — defined by the AI Knowledge & Verification module).", risk: "low" },
    { key: "knowledge.verification.read", description: "knowledge.verification.read (reserved — defined by the AI Knowledge & Verification module).", risk: "low" },
    { key: "knowledge.admin", description: "knowledge.admin (reserved — defined by the AI Knowledge & Verification module).", risk: "high" },
  ],
  navigation: [
    { label: "Ask", href: "/", permission: "knowledge.search" },
    { label: "Sources", href: "/sources", permission: "knowledge.read" },
    { label: "Review queues", href: "/reviews", permission: "knowledge.conflict.review" },
    { label: "Analytics", href: "/analytics", permission: "knowledge.read" },
  ],
};

export default manifest;
