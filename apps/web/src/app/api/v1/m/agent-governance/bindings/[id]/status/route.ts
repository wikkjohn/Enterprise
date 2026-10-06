import { z } from "zod";
import { route } from "@/lib/api";
import { AG_MODULE, ag } from "@/lib/agent-governance";

/** Enabling needs agent.policy.manage; disabling also accepts agent.suspend (checked by the service). */
export const POST = route({ auth: "session", module: AG_MODULE, permission: "agent.read", body: z.object({ status: z.enum(["active", "disabled"]) }), status: 200, handler: ({ platform, ctx, params, body }) => ag(platform).setBindingStatus(ctx, params.id!, body.status) });
