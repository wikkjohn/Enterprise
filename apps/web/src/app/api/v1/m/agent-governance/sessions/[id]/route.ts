import { route } from "@/lib/api";
import { AG_MODULE, ag } from "@/lib/agent-governance";

export const GET = route({ auth: "any", module: AG_MODULE, permission: "agent.audit.read", handler: ({ platform, ctx, params }) => ag(platform).getSession(ctx, params.id!) });
