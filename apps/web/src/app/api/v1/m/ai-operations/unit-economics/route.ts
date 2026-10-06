import { route } from "@/lib/api";
import { OPS_MODULE, ops } from "@/lib/ai-operations";

export const GET = route({ auth: "any", module: OPS_MODULE, permission: "ai_ops.cost.read", handler: ({ platform, ctx }) => ops(platform).unitEconomicsFor(ctx) });
