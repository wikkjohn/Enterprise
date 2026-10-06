import { route } from "@/lib/api";
import { KV_MODULE, kv } from "@/lib/knowledge";

export const POST = route({ auth: "any", module: KV_MODULE, permission: "knowledge.ingest", status: 202, rateLimit: { limit: 10, windowSeconds: 60 }, handler: ({ platform, ctx, params }) => kv(platform).syncSource(ctx, params.id!) });
