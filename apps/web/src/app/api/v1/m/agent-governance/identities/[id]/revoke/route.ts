import { route } from "@/lib/api";
import { AG_MODULE, ag } from "@/lib/agent-governance";

/** agent.manage or agent.suspend (checked by the service). */
export const POST = route({ auth: "session", module: AG_MODULE, permission: "agent.read", status: 200, handler: ({ platform, ctx, params }) => ag(platform).revokeIdentity(ctx, params.id!) });
