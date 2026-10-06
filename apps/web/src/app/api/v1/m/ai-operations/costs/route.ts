import { route } from "@/lib/api";
import { OPS_MODULE, listQuery, ops } from "@/lib/ai-operations";

export const GET = route({ auth: "any", module: OPS_MODULE, permission: "ai_ops.cost.read", query: listQuery, handler: ({ platform, ctx, query }) => ops(platform).breakdown(ctx, { from: query.from, to: query.to, by: query.by, basis: query.basis }) });
