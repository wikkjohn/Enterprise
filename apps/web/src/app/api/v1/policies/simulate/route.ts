import { z } from "zod";
import { route } from "@/lib/api";

export const POST = route({
  auth: "any",
  permission: "policy.read",
  status: 200,
  body: z.object({ key: z.string().optional(), version: z.number().int().optional(), definition: z.unknown().optional(), request: z.object({ subject: z.object({ type: z.string(), id: z.string() }).passthrough(), resource: z.object({ type: z.string() }).passthrough(), action: z.string(), context: z.record(z.unknown()).optional() }) }),
  handler: ({ platform, ctx, body }) => platform.policies.simulate(ctx, body as never),
});
