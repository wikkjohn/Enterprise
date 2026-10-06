import { route } from "@/lib/api";
import { AG_MODULE, ag, anyBody } from "@/lib/agent-governance";

export const POST = route({ auth: "any", module: AG_MODULE, permission: "agent.policy.manage", body: anyBody, handler: ({ platform, ctx, params, body }) => ag(platform).addBinding(ctx, params.id!, body) });
