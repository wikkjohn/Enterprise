import { z } from "zod";
import { route } from "@/lib/api";
import { dataClassQuery, MODULE, wi } from "@/lib/workflow";

const q = dataClassQuery.extend({ status: z.string().max(40).optional(), quadrant: z.string().max(40).optional(), department: z.string().max(120).optional(), sort: z.enum(["value", "savings", "roi", "priority", "risk"]).optional() });

export const GET = route({ auth: "any", module: MODULE, permission: "workflow.read", query: q, handler: ({ platform, ctx, query }) => wi(platform).listOpportunities(ctx, query) });
