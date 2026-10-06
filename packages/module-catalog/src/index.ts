import { agentGovernance } from "@eaop/module-agent-governance";
import { manifest as aiOperations } from "@eaop/module-ai-operations";
import { dataSecurity } from "@eaop/module-data-security";
import { integrationHub } from "@eaop/module-integration-hub";
import { knowledgeVerification } from "@eaop/module-knowledge-verification";
import { type ModuleManifest } from "@eaop/module-registry";
import { workflowIntelligence } from "@eaop/module-workflow-intelligence";
import { type ModuleDefinition } from "@eaop/platform";

/**
 * Every module known to this deployment, in navigation order. Installed
 * modules provide an install hook; placeholders are bare manifests.
 * Apps (web, worker, scripts) pass this to createPlatform({ modules }).
 */
export const MODULE_DEFINITIONS: ModuleDefinition[] = [
  workflowIntelligence,
  integrationHub,
  agentGovernance,
  dataSecurity,
  knowledgeVerification,
  { manifest: aiOperations },
];

export const MODULE_MANIFESTS: ModuleManifest[] = MODULE_DEFINITIONS.map((d) => d.manifest);
