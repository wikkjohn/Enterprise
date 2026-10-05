import { z } from "zod";
import { route } from "@/lib/api";
import { MODULE, wi } from "@/lib/workflow";

export const POST = route({ auth: "any", module: MODULE, permission: "workflow.approve", body: z.object({ decision: z.enum(["accept", "reject"]), note: z.string().max(2000).optional() }), handler: ({ platform, ctx, params, body }) => wi(platform).reviewRecommendation(ctx, params.id!, body) });
