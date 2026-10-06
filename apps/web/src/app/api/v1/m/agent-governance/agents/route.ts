import { route } from "@/lib/api";
import { AG_MODULE, ag, anyBody, listQuery } from "@/lib/agent-governance";

export const GET = route({ auth: "any", module: AG_MODULE, permission: "agent.read", query: listQuery, handler: ({ platform, ctx, query }) => ag(platform).listAgents(ctx, query) });
export const POST = route({ auth: "any", module: AG_MODULE, permission: "agent.register", body: anyBody, handler: ({ platform, ctx, body }) => ag(platform).registerAgent(ctx, body) });
