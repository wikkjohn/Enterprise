import { route } from "@/lib/api";
import { OPS_MODULE, ops } from "@/lib/ai-operations";

export const POST = route({ auth: "session", module: OPS_MODULE, permission: "ai_ops.cost.manage", status: 200, rateLimit: { limit: 6, windowSeconds: 60 }, handler: ({ platform, ctx }) => ops(platform).runScan(ctx) });
