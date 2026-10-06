import { route } from "@/lib/api";
import { OPS_MODULE, ops } from "@/lib/ai-operations";

export const DELETE = route({ auth: "session", module: OPS_MODULE, permission: "ai_ops.cost.manage", status: 200, handler: ({ platform, ctx, params }) => ops(platform).voidRecord(ctx, params.id!) });
