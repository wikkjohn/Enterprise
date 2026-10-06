import { route } from "@/lib/api";
import { AG_MODULE, ag } from "@/lib/agent-governance";

export const GET = route({ auth: "any", module: AG_MODULE, permission: "agent.read", handler: ({ platform, ctx }) => ag(platform).dashboard(ctx) });
