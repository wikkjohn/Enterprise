import { route } from "@/lib/api";
import { KV_MODULE, anyBody, kv } from "@/lib/knowledge";

/** Permission-filtered passages only (no generation) — for grounding prompts elsewhere. */
export const POST = route({ auth: "any", module: KV_MODULE, permission: "knowledge.search", body: anyBody, status: 200, rateLimit: { limit: 300, windowSeconds: 60 }, handler: ({ platform, ctx, body }) => kv(platform).retrieve(ctx, body) });
