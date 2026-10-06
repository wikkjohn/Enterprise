import { route } from "@/lib/api";
import { KV_MODULE, kv, listQuery } from "@/lib/knowledge";

export const GET = route({ auth: "any", module: KV_MODULE, permission: "knowledge.search", query: listQuery, handler: ({ platform, ctx, query }) => kv(platform).listQueries(ctx, { status: query.status, confidence: query.confidence, mine: query.mine === "true" }) });
