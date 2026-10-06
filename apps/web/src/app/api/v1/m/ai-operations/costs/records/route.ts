import { route } from "@/lib/api";
import { OPS_MODULE, anyBody, listQuery, ops } from "@/lib/ai-operations";

export const GET = route({ auth: "any", module: OPS_MODULE, permission: "ai_ops.cost.read", query: listQuery, handler: ({ platform, ctx, query }) => ops(platform).listRecords(ctx, { from: query.from, to: query.to }) });
export const POST = route({ auth: "any", module: OPS_MODULE, permission: "ai_ops.cost.manage", body: anyBody, rateLimit: { limit: 60, windowSeconds: 60 }, handler: ({ platform, ctx, body }) => ops(platform).addRecords(ctx, body) });
