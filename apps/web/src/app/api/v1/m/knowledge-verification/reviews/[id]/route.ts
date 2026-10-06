import { route } from "@/lib/api";
import { KV_MODULE, anyBody, kv } from "@/lib/knowledge";

export const PATCH = route({ auth: "session", module: KV_MODULE, permission: "knowledge.read", body: anyBody, handler: ({ platform, ctx, params, body }) => kv(platform).updateReview(ctx, params.id!, body) });
