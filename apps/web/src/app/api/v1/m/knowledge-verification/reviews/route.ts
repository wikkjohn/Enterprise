import { route } from "@/lib/api";
import { KV_MODULE, kv, listQuery } from "@/lib/knowledge";

/** Review queues (escalations, conflicts, stale/expired/ownerless documents). The service requires knowledge.conflict.review or knowledge.manage. */
export const GET = route({ auth: "any", module: KV_MODULE, permission: "knowledge.read", query: listQuery, handler: ({ platform, ctx, query }) => kv(platform).listReviews(ctx, { status: query.status, kind: query.kind }) });
