import { z } from "zod";
import { route } from "@/lib/api";

export const POST = route({ auth: "session", permission: "policy.manage", status: 200, body: z.object({ version: z.number().int().min(1) }), handler: ({ platform, ctx, params, body }) => platform.policies.activate(ctx, params.key!, body.version) });
