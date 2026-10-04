/** Stable identifiers of the platform's modular applications. Never rename. */
export const MODULE_IDS = [
  "workflow_intelligence",
  "agent_governance",
  "data_security",
  "integration_hub",
  "knowledge_verification",
  "ai_operations",
] as const;

export type ModuleId = (typeof MODULE_IDS)[number];
/** "core" identifies shared-platform capabilities (always enabled). */
export type OwnerId = ModuleId | "core";

export function isModuleId(value: unknown): value is ModuleId {
  return typeof value === "string" && (MODULE_IDS as readonly string[]).includes(value);
}
