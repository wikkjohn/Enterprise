import { route } from "@/lib/api";
import { OPS_MODULE, anyBody, listQuery, ops } from "@/lib/ai-operations";

export const GET = route({ auth: "any", module: OPS_MODULE, permission: "ai_ops.read", query: listQuery, handler: ({ platform, ctx, query }) => ops(platform).listTools(ctx, { status: query.status, q: query.q }) });
export const POST = route({ auth: "session", module: OPS_MODULE, permission: "ai_ops.tool.manage", body: anyBody, handler: ({ platform, ctx, body }) => ops(platform).addTool(ctx, body) });
