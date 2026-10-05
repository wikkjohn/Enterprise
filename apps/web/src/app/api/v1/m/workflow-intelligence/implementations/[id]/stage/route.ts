import { z } from "zod";
import { route } from "@/lib/api";
import { MODULE, wi } from "@/lib/workflow";

export const POST = route({ auth: "any", module: MODULE, permission: "workflow.implementation.manage", body: z.object({ stage: z.enum(["proposed", "approved", "design", "build", "testing", "pilot", "production", "measured"]), note: z.string().max(1000).optional() }), handler: ({ platform, ctx, params, body }) => wi(platform).advanceStage(ctx, params.id!, body.stage, body.note) });
