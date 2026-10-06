import { route } from "@/lib/api";
import { AG_MODULE, ag, anyBody } from "@/lib/agent-governance";

/** Issues a shared API key bound to the agent. The raw key is in this response only. */
export const POST = route({ auth: "session", module: AG_MODULE, permission: "agent.manage", body: anyBody, rateLimit: { limit: 20, windowSeconds: 60 }, handler: ({ platform, ctx, params, body }) => ag(platform).issueApiKey(ctx, params.id!, body) });
