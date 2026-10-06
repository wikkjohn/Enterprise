import { route } from "@/lib/api";
import { OPS_MODULE, anyBody, ops } from "@/lib/ai-operations";

export const GET = route({ auth: "any", module: OPS_MODULE, permission: "ai_ops.read", handler: ({ platform, ctx, params }) => ops(platform).getVendor(ctx, params.id!) });
export const PATCH = route({ auth: "session", module: OPS_MODULE, permission: "ai_ops.vendor.manage", body: anyBody, handler: ({ platform, ctx, params, body }) => ops(platform).saveVendor(ctx, params.id!, body) });
