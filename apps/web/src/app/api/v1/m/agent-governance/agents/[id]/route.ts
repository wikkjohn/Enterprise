import { route } from "@/lib/api";
import { AG_MODULE, ag, anyBody } from "@/lib/agent-governance";

export const GET = route({ auth: "any", module: AG_MODULE, permission: "agent.read", handler: ({ platform, ctx, params }) => ag(platform).getAgent(ctx, params.id!) });
export const PATCH = route({ auth: "any", module: AG_MODULE, permission: "agent.manage", body: anyBody, handler: ({ platform, ctx, params, body }) => ag(platform).updateAgent(ctx, params.id!, body) });
