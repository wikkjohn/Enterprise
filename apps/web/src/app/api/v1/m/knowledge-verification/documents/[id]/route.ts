import { route } from "@/lib/api";
import { KV_MODULE, anyBody, kv } from "@/lib/knowledge";

export const GET = route({ auth: "any", module: KV_MODULE, permission: "knowledge.read", handler: ({ platform, ctx, params }) => kv(platform).getDocument(ctx, params.id!) });
export const PATCH = route({ auth: "session", module: KV_MODULE, permission: "knowledge.manage", body: anyBody, handler: ({ platform, ctx, params, body }) => kv(platform).updateDocument(ctx, params.id!, body) });
