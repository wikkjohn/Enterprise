import { route } from "@/lib/api";
import { OPS_MODULE, anyBody, ops } from "@/lib/ai-operations";

export const GET = route({ auth: "any", module: OPS_MODULE, permission: "ai_ops.read", handler: ({ platform, ctx }) => ops(platform).listVendors(ctx) });
export const POST = route({ auth: "session", module: OPS_MODULE, permission: "ai_ops.vendor.manage", body: anyBody, handler: ({ platform, ctx, body }) => ops(platform).saveVendor(ctx, null, body) });
