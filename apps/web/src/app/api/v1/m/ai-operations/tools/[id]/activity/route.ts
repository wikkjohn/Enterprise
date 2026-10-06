import { route } from "@/lib/api";
import { OPS_MODULE, anyBody, ops } from "@/lib/ai-operations";

export const POST = route({ auth: "any", module: OPS_MODULE, permission: "ai_ops.tool.manage", body: anyBody, status: 200, rateLimit: { limit: 60, windowSeconds: 60 }, handler: ({ platform, ctx, params, body }) => ops(platform).recordActivity(ctx, params.id!, body) });
