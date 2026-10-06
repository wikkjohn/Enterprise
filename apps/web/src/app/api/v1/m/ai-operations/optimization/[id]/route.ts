import { route } from "@/lib/api";
import { OPS_MODULE, anyBody, ops } from "@/lib/ai-operations";

export const PATCH = route({ auth: "session", module: OPS_MODULE, permission: "ai_ops.cost.manage", body: anyBody, handler: ({ platform, ctx, params, body }) => ops(platform).decideFinding(ctx, params.id!, body) });
