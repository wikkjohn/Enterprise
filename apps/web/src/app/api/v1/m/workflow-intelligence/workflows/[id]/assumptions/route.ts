import { z } from "zod";
import { route } from "@/lib/api";
import { MODULE, wi } from "@/lib/workflow";

export const PUT = route({ auth: "any", module: MODULE, permission: "workflow.roi.manage", body: z.object({ assumptions: z.array(z.unknown()) }), handler: async ({ platform, ctx, params, body }) => { await wi(platform).setAssumptions(ctx, params.id!, body.assumptions as never); return { saved: true }; } });
