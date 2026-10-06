import { route } from "@/lib/api";
import { AG_MODULE, ag, anyBody } from "@/lib/agent-governance";

/** The designated review owner (with agent.read) or anyone with agent.manage. */
export const POST = route({ auth: "session", module: AG_MODULE, permission: "agent.read", body: anyBody, status: 200, handler: ({ platform, ctx, params, body }) => ag(platform).completeReview(ctx, params.id!, body) });
