import { route } from "@/lib/api";
import { KV_MODULE, anyBody, kv } from "@/lib/knowledge";

/** Ask a question: permission-filtered retrieval → cited answer → claim verification → confidence. */
export const POST = route({ auth: "any", module: KV_MODULE, permission: "knowledge.search", body: anyBody, status: 200, rateLimit: { limit: 60, windowSeconds: 60 }, handler: ({ platform, ctx, body }) => kv(platform).ask(ctx, body) });
