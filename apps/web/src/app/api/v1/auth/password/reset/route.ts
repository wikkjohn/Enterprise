import { z } from "zod";
import { route } from "@/lib/api";

export const POST = route({
  auth: "public",
  rateLimit: { limit: 10, windowSeconds: 900 },
  body: z.object({ token: z.string().min(20).max(128), password: z.string().min(1).max(256) }),
  status: 200,
  handler: async ({ platform, body, meta }) => {
    await platform.auth.resetPassword(body.token, body.password, meta);
    return { ok: true };
  },
});
