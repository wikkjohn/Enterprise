import { route } from "@/lib/api";
import { OPS_MODULE, anyBody, ops } from "@/lib/ai-operations";

export const POST = route({ auth: "session", module: OPS_MODULE, permission: "ai_ops.cost.manage", body: anyBody, status: 200, handler: ({ platform, ctx, params, body }) => ops(platform).allocateRecord(ctx, params.id!, body) });
export const DELETE = route({ auth: "session", module: OPS_MODULE, permission: "ai_ops.cost.manage", status: 200, handler: ({ platform, ctx, params }) => ops(platform).unallocateRecord(ctx, params.id!) });
