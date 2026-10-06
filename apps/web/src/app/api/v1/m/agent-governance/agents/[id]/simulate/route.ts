import { route } from "@/lib/api";
import { AG_MODULE, ag, anyBody } from "@/lib/agent-governance";

export const POST = route({ auth: "any", module: AG_MODULE, permission: "agent.policy.read", body: anyBody, status: 200, handler: ({ platform, ctx, params, body }) => ag(platform).simulate(ctx, params.id!, body) });
