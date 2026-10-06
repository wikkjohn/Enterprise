import { aiOpsService, type AiOpsService } from "@eaop/module-ai-operations";
import { type Platform } from "@eaop/platform";
import { z } from "zod";

/** The AI Operations service, built by the module's install hook on the shared platform. */
export const ops = (platform: Platform): AiOpsService => aiOpsService(platform);

export const OPS_MODULE = "ai_operations" as const;
export const OPS_BASE = "/m/ai-operations";
export const anyBody = z.union([z.record(z.unknown()), z.array(z.unknown())]);
const s = (max = 64) => z.string().max(max).optional();
export const listQuery = z.object({ status: s(), stage: s(), q: s(200), from: s(10), to: s(10), by: s(), basis: s(), department: s(120), programId: s(), mine: z.enum(["true", "false"]).optional() });
