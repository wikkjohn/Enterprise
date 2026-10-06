import { route } from "@/lib/api";
import { AG_MODULE, ag } from "@/lib/agent-governance";

/** Agent runtime API — the caller must authenticate with an API key bound to an agent; the service rejects every other actor. */
export const GET = route({ auth: "any", module: AG_MODULE, handler: ({ platform, ctx, params }) => ag(platform).getRequest(ctx, params.id!) });
