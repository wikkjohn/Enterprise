import { route } from "@/lib/api";
import { KV_MODULE, anyBody, kv } from "@/lib/knowledge";

/** A reviewer decides: keep_a / keep_b (the other is superseded), both_valid, or not_a_conflict. */
export const POST = route({ auth: "session", module: KV_MODULE, permission: "knowledge.conflict.review", body: anyBody, status: 200, handler: ({ platform, ctx, params, body }) => kv(platform).resolveConflict(ctx, params.id!, body) });
