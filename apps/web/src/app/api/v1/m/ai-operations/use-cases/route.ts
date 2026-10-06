import { route } from "@/lib/api";
import { OPS_MODULE, anyBody, listQuery, ops } from "@/lib/ai-operations";

export const GET = route({ auth: "any", module: OPS_MODULE, permission: "ai_ops.read", query: listQuery, handler: ({ platform, ctx, query }) => ops(platform).listUseCases(ctx, { department: query.department }) });
export const POST = route({ auth: "session", module: OPS_MODULE, permission: "ai_ops.training.manage", body: anyBody, handler: ({ platform, ctx, body }) => ops(platform).saveUseCase(ctx, null, body) });
