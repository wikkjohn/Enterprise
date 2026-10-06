import { route } from "@/lib/api";
import { OPS_MODULE, anyBody, ops } from "@/lib/ai-operations";

export const PATCH = route({ auth: "session", module: OPS_MODULE, permission: "ai_ops.admin", body: anyBody, handler: ({ platform, ctx, params, body }) => ops(platform).saveTemplate(ctx, params.id!, body) });
