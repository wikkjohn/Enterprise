import { route } from "@/lib/api";
import { OPS_MODULE, anyBody, ops } from "@/lib/ai-operations";

export const POST = route({ auth: "session", module: OPS_MODULE, permission: "ai_ops.vendor.manage", body: anyBody, handler: ({ platform, ctx, body }) => ops(platform).saveContract(ctx, null, body) });
