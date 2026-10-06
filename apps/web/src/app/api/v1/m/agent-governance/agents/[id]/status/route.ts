import { route } from "@/lib/api";
import { AG_MODULE, ag, anyBody } from "@/lib/agent-governance";

/** Lifecycle: approve / restrict / retire / back to pending. Lifting a suspension also needs agent.suspend (checked by the service). */
export const POST = route({ auth: "session", module: AG_MODULE, permission: "agent.manage", body: anyBody, status: 200, handler: ({ platform, ctx, params, body }) => ag(platform).setStatus(ctx, params.id!, body) });
