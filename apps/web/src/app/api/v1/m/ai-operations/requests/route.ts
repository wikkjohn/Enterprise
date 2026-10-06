import { route } from "@/lib/api";
import { OPS_MODULE, anyBody, listQuery, ops } from "@/lib/ai-operations";

export const GET = route({ auth: "any", module: OPS_MODULE, permission: "ai_ops.read", query: listQuery, handler: ({ platform, ctx, query }) => ops(platform).listRequests(ctx, { stage: query.stage, mine: query.mine === "true" }) });
export const POST = route({ auth: "session", module: OPS_MODULE, permission: "ai_ops.read", body: anyBody, rateLimit: { limit: 20, windowSeconds: 60 }, handler: ({ platform, ctx, body }) => ops(platform).submitRequest(ctx, body) });
