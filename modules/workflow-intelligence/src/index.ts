import { type ModuleManifest } from "@eaop/module-registry";

/**
 * PLACEHOLDER manifest for AI Workflow Intelligence.
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
  "workflow.created",
  "workflow.analyzed",
  "workflow.opportunity.created",
  "workflow.approved",
  "workflow.implementation.started",
  "workflow.production.started",
  "workflow.roi.measured",
] as const;

export const manifest: ModuleManifest = {
  id: "workflow_intelligence",
  name: "AI Workflow Intelligence",
  shortName: "Workflow Intelligence",
  description: "Find, score and redesign the workflows where AI creates measurable value, and track realized ROI.",
  version: "0.0.0",
  installStatus: "not_installed",
  icon: "Workflow",
  basePath: "/m/workflow-intelligence",
  entryPermission: "workflow.read",
  permissions: [
    { key: "workflow.read", description: "workflow.read (reserved — defined by the AI Workflow Intelligence module).", risk: "low" },
    { key: "workflow.create", description: "workflow.create (reserved — defined by the AI Workflow Intelligence module).", risk: "low" },
    { key: "workflow.update", description: "workflow.update (reserved — defined by the AI Workflow Intelligence module).", risk: "low" },
    { key: "workflow.delete", description: "workflow.delete (reserved — defined by the AI Workflow Intelligence module).", risk: "high" },
    { key: "workflow.analyze", description: "workflow.analyze (reserved — defined by the AI Workflow Intelligence module).", risk: "low" },
    { key: "workflow.approve", description: "workflow.approve (reserved — defined by the AI Workflow Intelligence module).", risk: "high" },
    { key: "workflow.roi.read", description: "workflow.roi.read (reserved — defined by the AI Workflow Intelligence module).", risk: "low" },
    { key: "workflow.roi.manage", description: "workflow.roi.manage (reserved — defined by the AI Workflow Intelligence module).", risk: "high" },
    { key: "workflow.implementation.manage", description: "workflow.implementation.manage (reserved — defined by the AI Workflow Intelligence module).", risk: "high" },
  ],
  navigation: [
    { label: "Dashboard", href: "/", permission: "workflow.read" },
    { label: "Inventory", href: "/workflows", permission: "workflow.read" },
    { label: "Opportunities", href: "/opportunities", permission: "workflow.read" },
    { label: "Implementations", href: "/implementations", permission: "workflow.read" },
  ],
};

export default manifest;
