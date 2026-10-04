import { type ModuleManifest } from "@eaop/module-registry";

/**
 * PLACEHOLDER manifest for AI Agent Governance.
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
  "agent.registered",
  "agent.approved",
  "agent.suspended",
  "agent.action.requested",
  "agent.action.allowed",
  "agent.action.denied",
  "agent.approval.required",
  "agent.incident.created",
] as const;

export const manifest: ModuleManifest = {
  id: "agent_governance",
  name: "AI Agent Governance",
  shortName: "Agent Governance",
  description: "Enterprise control plane for AI agents: inventory, identity, permissions, approvals, kill switch and replay.",
  version: "0.0.0",
  installStatus: "not_installed",
  icon: "ShieldCheck",
  basePath: "/m/agent-governance",
  entryPermission: "agent.read",
  permissions: [
    { key: "agent.read", description: "agent.read (reserved — defined by the AI Agent Governance module).", risk: "low" },
    { key: "agent.register", description: "agent.register (reserved — defined by the AI Agent Governance module).", risk: "low" },
    { key: "agent.manage", description: "agent.manage (reserved — defined by the AI Agent Governance module).", risk: "high" },
    { key: "agent.suspend", description: "agent.suspend (reserved — defined by the AI Agent Governance module).", risk: "high" },
    { key: "agent.policy.read", description: "agent.policy.read (reserved — defined by the AI Agent Governance module).", risk: "low" },
    { key: "agent.policy.manage", description: "agent.policy.manage (reserved — defined by the AI Agent Governance module).", risk: "high" },
    { key: "agent.action.read", description: "agent.action.read (reserved — defined by the AI Agent Governance module).", risk: "low" },
    { key: "agent.approval.review", description: "agent.approval.review (reserved — defined by the AI Agent Governance module).", risk: "low" },
    { key: "agent.audit.read", description: "agent.audit.read (reserved — defined by the AI Agent Governance module).", risk: "low" },
    { key: "agent.incident.manage", description: "agent.incident.manage (reserved — defined by the AI Agent Governance module).", risk: "high" },
  ],
  navigation: [
    { label: "Security dashboard", href: "/", permission: "agent.read" },
    { label: "Agents", href: "/agents", permission: "agent.read" },
    { label: "Approvals", href: "/approvals", permission: "agent.approval.review" },
    { label: "Activity & replay", href: "/activity", permission: "agent.action.read" },
  ],
};

export default manifest;
