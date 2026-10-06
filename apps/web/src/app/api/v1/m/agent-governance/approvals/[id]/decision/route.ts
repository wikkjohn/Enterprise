import { route } from "@/lib/api";
import { AG_MODULE, ag, anyBody } from "@/lib/agent-governance";

/** approve | reject | request_clarification | escalate. People only; never the user the agent acts for. */
export const POST = route({ auth: "session", module: AG_MODULE, permission: "agent.approval.review", body: anyBody, status: 200, handler: ({ platform, ctx, params, body }) => ag(platform).decideApproval(ctx, params.id!, body) });
