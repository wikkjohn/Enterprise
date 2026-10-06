import { route } from "@/lib/api";
import { AG_MODULE, ag, anyBody } from "@/lib/agent-governance";

/** Agent runtime API — the caller must authenticate with an API key bound to an agent; the service rejects every other actor. */
export const POST = route({ auth: "any", module: AG_MODULE, body: anyBody, rateLimit: { limit: 600, windowSeconds: 60 }, handler: ({ platform, ctx, params, body }) => ag(platform).recordActivity(ctx, params.id!, body) });
