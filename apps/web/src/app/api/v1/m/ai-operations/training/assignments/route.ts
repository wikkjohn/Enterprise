import { route } from "@/lib/api";
import { OPS_MODULE, listQuery, ops } from "@/lib/ai-operations";

export const GET = route({ auth: "any", module: OPS_MODULE, permission: "ai_ops.read", query: listQuery, handler: ({ platform, ctx, query }) => ops(platform).listAssignments(ctx, { programId: query.programId, mine: query.mine === "true" }) });
