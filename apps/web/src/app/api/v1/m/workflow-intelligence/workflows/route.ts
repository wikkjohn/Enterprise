import { z } from "zod";
import { route } from "@/lib/api";
import { anyBody, dataClassQuery, MODULE, wi } from "@/lib/workflow";

const listQuery = dataClassQuery.extend({ department: z.string().max(120).optional(), status: z.string().max(40).optional(), riskCategory: z.string().max(40).optional(), q: z.string().max(200).optional() });

export const GET = route({ auth: "any", module: MODULE, permission: "workflow.read", query: listQuery, handler: ({ platform, ctx, query }) => wi(platform).list(ctx, query) });
export const POST = route({ auth: "any", module: MODULE, permission: "workflow.create", body: anyBody, status: 201, idempotent: true, handler: ({ platform, ctx, body }) => wi(platform).create(ctx, body as never) });
