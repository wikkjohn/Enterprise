import { z } from "zod";
import { RATE_LIMITS } from "@eaop/security";
import { route } from "@/lib/api";

export const POST = route({
  auth: "any",
  permission: "ai.use",
  rateLimit: RATE_LIMITS.ai,
  status: 200,
  body: z.record(z.unknown()),
  handler: ({ platform, ctx, body }) => platform.ai.execute(ctx, body as never),
});
