import { z } from "zod";
import { route } from "@/lib/api";
import { dataClassQuery, MODULE, wi } from "@/lib/workflow";

export const GET = route({ auth: "any", module: MODULE, permission: "workflow.read", query: dataClassQuery.extend({ stage: z.string().max(40).optional() }), handler: ({ platform, ctx, query }) => wi(platform).listImplementations(ctx, query) });
