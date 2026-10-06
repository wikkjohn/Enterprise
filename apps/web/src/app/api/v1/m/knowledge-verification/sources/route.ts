import { route } from "@/lib/api";
import { KV_MODULE, anyBody, kv } from "@/lib/knowledge";

export const GET = route({ auth: "any", module: KV_MODULE, permission: "knowledge.read", handler: ({ platform, ctx }) => kv(platform).listSources(ctx) });
export const POST = route({ auth: "session", module: KV_MODULE, permission: "knowledge.source.manage", body: anyBody, handler: ({ platform, ctx, body }) => kv(platform).createSource(ctx, body) });
