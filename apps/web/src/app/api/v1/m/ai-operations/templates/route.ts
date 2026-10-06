import { route } from "@/lib/api";
import { OPS_MODULE, anyBody, ops } from "@/lib/ai-operations";

export const GET = route({ auth: "any", module: OPS_MODULE, permission: "ai_ops.read", handler: ({ platform, ctx }) => ops(platform).listTemplates(ctx) });
export const POST = route({ auth: "session", module: OPS_MODULE, permission: "ai_ops.admin", body: anyBody, handler: ({ platform, ctx, body }) => ops(platform).saveTemplate(ctx, null, body) });
