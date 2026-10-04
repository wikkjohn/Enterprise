import { z } from "zod";
import { route } from "@/lib/api";

export const POST = route({ auth: "session", permission: "policy.manage", body: z.object({ definition: z.unknown(), changeNote: z.string().max(500).optional() }), handler: ({ platform, ctx, params, body }) => platform.policies.addVersion(ctx, params.key!, body.definition, body.changeNote) });
