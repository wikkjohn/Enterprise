import { route } from "@/lib/api";
import { AG_MODULE, ag, anyBody } from "@/lib/agent-governance";

/** Kill switch. Requires typing the agent name as confirmation; every action is audited and opens an incident. */
export const POST = route({ auth: "session", module: AG_MODULE, permission: "agent.suspend", body: anyBody, status: 200, rateLimit: { limit: 30, windowSeconds: 60 }, handler: ({ platform, ctx, params, body }) => ag(platform).emergency(ctx, params.id!, body) });
