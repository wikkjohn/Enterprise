import { z } from "zod";
import { route } from "@/lib/api";

export const POST = route({
  auth: "public",
  rateLimit: { limit: 5, windowSeconds: 900 },
  body: z.object({ email: z.string().email().max(320) }),
  status: 202,
  handler: async ({ platform, body, meta }) => {
    await platform.auth.requestPasswordReset(body.email, meta);
    return { ok: true };
  },
});
