import { route } from "@/lib/api";
import { AG_MODULE, ag, anyBody } from "@/lib/agent-governance";

export const POST = route({ auth: "session", module: AG_MODULE, permission: "agent.manage", body: anyBody, handler: ({ platform, ctx, params, body }) => ag(platform).scheduleReview(ctx, params.id!, body) });
