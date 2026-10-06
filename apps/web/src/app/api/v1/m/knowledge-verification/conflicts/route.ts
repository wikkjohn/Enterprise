import { route } from "@/lib/api";
import { KV_MODULE, kv, listQuery } from "@/lib/knowledge";

export const GET = route({ auth: "any", module: KV_MODULE, permission: "knowledge.conflict.review", query: listQuery, handler: ({ platform, ctx, query }) => kv(platform).listConflicts(ctx, { status: query.status }) });
