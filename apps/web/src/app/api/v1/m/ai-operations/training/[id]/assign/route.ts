import { route } from "@/lib/api";
import { OPS_MODULE, anyBody, ops } from "@/lib/ai-operations";

export const POST = route({ auth: "session", module: OPS_MODULE, permission: "ai_ops.training.manage", body: anyBody, status: 200, handler: ({ platform, ctx, params, body }) => ops(platform).assignTraining(ctx, params.id!, body) });
