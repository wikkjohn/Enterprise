import { route } from "@/lib/api";
import { AG_MODULE, ag, listQuery } from "@/lib/agent-governance";

export const GET = route({ auth: "any", module: AG_MODULE, permission: "agent.read", query: listQuery, handler: ({ platform, ctx, query }) => ag(platform).listIncidents(ctx, query) });
