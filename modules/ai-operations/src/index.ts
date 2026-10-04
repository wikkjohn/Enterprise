import { type ModuleManifest } from "@eaop/module-registry";

/**
 * PLACEHOLDER manifest for AI Operations Management.
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
  "ai_ops.tool.added",
  "ai_ops.contract.renewal_due",
  "ai_ops.cost.threshold_exceeded",
  "ai_ops.request.submitted",
  "ai_ops.request.approved",
  "ai_ops.training.required",
  "ai_ops.optimization.found",
] as const;

export const manifest: ModuleManifest = {
  id: "ai_operations",
  name: "AI Operations Management",
  shortName: "AI Operations",
  description: "System of record for the AI estate: tools, vendors, costs, adoption, training, requests and value.",
  version: "0.0.0",
  installStatus: "not_installed",
  icon: "Gauge",
  basePath: "/m/ai-operations",
  entryPermission: "ai_ops.read",
  permissions: [
    { key: "ai_ops.read", description: "ai_ops.read (reserved — defined by the AI Operations Management module).", risk: "low" },
    { key: "ai_ops.tool.manage", description: "ai_ops.tool.manage (reserved — defined by the AI Operations Management module).", risk: "high" },
    { key: "ai_ops.vendor.manage", description: "ai_ops.vendor.manage (reserved — defined by the AI Operations Management module).", risk: "high" },
    { key: "ai_ops.cost.read", description: "ai_ops.cost.read (reserved — defined by the AI Operations Management module).", risk: "low" },
    { key: "ai_ops.cost.manage", description: "ai_ops.cost.manage (reserved — defined by the AI Operations Management module).", risk: "high" },
    { key: "ai_ops.adoption.read", description: "ai_ops.adoption.read (reserved — defined by the AI Operations Management module).", risk: "low" },
    { key: "ai_ops.training.manage", description: "ai_ops.training.manage (reserved — defined by the AI Operations Management module).", risk: "high" },
    { key: "ai_ops.request.manage", description: "ai_ops.request.manage (reserved — defined by the AI Operations Management module).", risk: "high" },
    { key: "ai_ops.admin", description: "ai_ops.admin (reserved — defined by the AI Operations Management module).", risk: "high" },
  ],
  navigation: [
    { label: "Executive dashboard", href: "/", permission: "ai_ops.read" },
    { label: "Tools & vendors", href: "/tools", permission: "ai_ops.read" },
    { label: "Costs", href: "/costs", permission: "ai_ops.cost.read" },
    { label: "Requests", href: "/requests", permission: "ai_ops.read" },
  ],
};

export default manifest;
