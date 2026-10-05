import { workflowService, type WorkflowService } from "@eaop/module-workflow-intelligence";
import { type Platform } from "@eaop/platform";
import { z } from "zod";

/** The Workflow Intelligence service, built by the module's install hook on the shared platform. */
export const wi = (platform: Platform): WorkflowService => workflowService(platform);

export const MODULE = "workflow_intelligence" as const;
export const WI_BASE = "/m/workflow-intelligence";
export const anyBody = z.record(z.unknown());
export const dataClassQuery = z.object({ dataClass: z.enum(["production", "sample"]).optional() });
