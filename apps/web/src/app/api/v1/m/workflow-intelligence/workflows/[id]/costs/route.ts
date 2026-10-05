import { z } from "zod";
import { route } from "@/lib/api";
import { MODULE, wi } from "@/lib/workflow";

export const PUT = route({ auth: "any", module: MODULE, permission: "workflow.roi.manage", body: z.object({ costs: z.array(z.unknown()) }), handler: async ({ platform, ctx, params, body }) => { await wi(platform).setCosts(ctx, params.id!, body.costs as never); return { saved: true }; } });
