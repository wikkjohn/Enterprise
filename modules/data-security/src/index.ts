import { type ModuleManifest } from "@eaop/module-registry";

/**
 * PLACEHOLDER manifest for AI Data Security.
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
  "security.incident.created",
  "data_security.asset.classified",
  "data_security.dlp.blocked",
  "data_security.dlp.redacted",
] as const;

export const manifest: ModuleManifest = {
  id: "data_security",
  name: "AI Data Security",
  shortName: "Data Security",
  description: "Discover, classify and protect enterprise data used with AI: exposure, shadow AI, AI DLP and incidents.",
  version: "0.0.0",
  installStatus: "not_installed",
  icon: "Lock",
  basePath: "/m/data-security",
  entryPermission: "data_security.read",
  permissions: [
    { key: "data_security.read", description: "data_security.read (reserved — defined by the AI Data Security module).", risk: "low" },
    { key: "data_security.scan", description: "data_security.scan (reserved — defined by the AI Data Security module).", risk: "low" },
    { key: "data_security.classification.manage", description: "data_security.classification.manage (reserved — defined by the AI Data Security module).", risk: "high" },
    { key: "data_security.policy.manage", description: "data_security.policy.manage (reserved — defined by the AI Data Security module).", risk: "high" },
    { key: "data_security.incident.read", description: "data_security.incident.read (reserved — defined by the AI Data Security module).", risk: "low" },
    { key: "data_security.incident.manage", description: "data_security.incident.manage (reserved — defined by the AI Data Security module).", risk: "high" },
    { key: "data_security.remediation.manage", description: "data_security.remediation.manage (reserved — defined by the AI Data Security module).", risk: "high" },
    { key: "data_security.shadow_ai.read", description: "data_security.shadow_ai.read (reserved — defined by the AI Data Security module).", risk: "low" },
  ],
  navigation: [
    { label: "Dashboard", href: "/", permission: "data_security.read" },
    { label: "Data assets", href: "/assets", permission: "data_security.read" },
    { label: "Shadow AI", href: "/shadow-ai", permission: "data_security.shadow_ai.read" },
    { label: "Incidents", href: "/incidents", permission: "data_security.incident.read" },
  ],
};

export default manifest;
