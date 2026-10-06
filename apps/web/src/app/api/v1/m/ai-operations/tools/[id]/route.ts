import { route } from "@/lib/api";
import { OPS_MODULE, anyBody, ops } from "@/lib/ai-operations";

export const GET = route({ auth: "any", module: OPS_MODULE, permission: "ai_ops.read", handler: ({ platform, ctx, params }) => ops(platform).getTool(ctx, params.id!) });
export const PATCH = route({ auth: "session", module: OPS_MODULE, permission: "ai_ops.tool.manage", body: anyBody, handler: ({ platform, ctx, params, body }) => ops(platform).updateTool(ctx, params.id!, body) });
