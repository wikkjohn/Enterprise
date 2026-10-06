import { route } from "@/lib/api";
import { KV_MODULE, anyBody, kv } from "@/lib/knowledge";

export const PATCH = route({ auth: "session", module: KV_MODULE, permission: "knowledge.source.manage", body: anyBody, handler: ({ platform, ctx, params, body }) => kv(platform).updateSource(ctx, params.id!, body) });
