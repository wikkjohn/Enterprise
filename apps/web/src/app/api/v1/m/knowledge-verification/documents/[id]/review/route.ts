import { route } from "@/lib/api";
import { KV_MODULE, anyBody, kv } from "@/lib/knowledge";

/** Mark a document reviewed and still accurate; sets the next review date. */
export const POST = route({ auth: "session", module: KV_MODULE, permission: "knowledge.manage", body: anyBody, status: 200, handler: ({ platform, ctx, params, body }) => kv(platform).markReviewed(ctx, params.id!, body) });
