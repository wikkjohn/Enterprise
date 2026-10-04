import { type ModuleManifest } from "@eaop/module-registry";

/**
 * PLACEHOLDER manifest for Enterprise AI Integration.
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
  "integration.workflow.created",
  "integration.execution.started",
  "integration.execution.failed",
  "integration.execution.completed",
  "integration.approval.required",
  "integration.action.executed",
] as const;

export const manifest: ModuleManifest = {
  id: "integration_hub",
  name: "Enterprise AI Integration",
  shortName: "Integration",
  description: "Controlled execution layer connecting AI and agents to enterprise systems under policy and approval.",
  version: "0.0.0",
  installStatus: "not_installed",
  icon: "Cable",
  basePath: "/m/integration-hub",
  entryPermission: "integration.read",
  permissions: [
    { key: "integration.read", description: "integration.read (reserved — defined by the Enterprise AI Integration module).", risk: "low" },
    { key: "integration.create", description: "integration.create (reserved — defined by the Enterprise AI Integration module).", risk: "low" },
    { key: "integration.manage", description: "integration.manage (reserved — defined by the Enterprise AI Integration module).", risk: "high" },
    { key: "integration.execute", description: "integration.execute (reserved — defined by the Enterprise AI Integration module).", risk: "high" },
    { key: "integration.approve", description: "integration.approve (reserved — defined by the Enterprise AI Integration module).", risk: "high" },
    { key: "integration.connector.use", description: "integration.connector.use (reserved — defined by the Enterprise AI Integration module).", risk: "low" },
    { key: "integration.history.read", description: "integration.history.read (reserved — defined by the Enterprise AI Integration module).", risk: "low" },
    { key: "integration.admin", description: "integration.admin (reserved — defined by the Enterprise AI Integration module).", risk: "high" },
  ],
  navigation: [
    { label: "Workflows", href: "/", permission: "integration.read" },
    { label: "Action catalog", href: "/actions", permission: "integration.read" },
    { label: "Executions", href: "/executions", permission: "integration.history.read" },
  ],
};

export default manifest;
