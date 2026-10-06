import { route } from "@/lib/api";
import { KV_MODULE, anyBody, kv } from "@/lib/knowledge";

export const GET = route({ auth: "any", module: KV_MODULE, permission: "knowledge.read", handler: ({ platform, ctx }) => kv(platform).getSettings(ctx) });
export const PATCH = route({ auth: "session", module: KV_MODULE, permission: "knowledge.admin", body: anyBody, handler: ({ platform, ctx, body }) => kv(platform).updateSettings(ctx, body) });
