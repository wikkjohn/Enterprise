import { route } from "@/lib/api";
import { OPS_MODULE, anyBody, ops } from "@/lib/ai-operations";

export const POST = route({ auth: "any", module: OPS_MODULE, permission: "ai_ops.tool.manage", body: anyBody, status: 200, handler: ({ platform, ctx, params, body }) => ops(platform).assignLicenses(ctx, params.id!, body) });
