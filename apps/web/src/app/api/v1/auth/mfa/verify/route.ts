import { z } from "zod";
import { SESSION_COOKIE } from "@eaop/security";
import { AppError } from "@eaop/shared-types";
import { route } from "@/lib/api";

export const POST = route({
  auth: "public",
  rateLimit: { limit: 10, windowSeconds: 300 },
  body: z.object({ code: z.string().regex(/^\d{6}$/) }),
  status: 200,
  handler: async ({ platform, body, meta, cookies }) => {
    const token = cookies[SESSION_COOKIE];
    if (!token) throw new AppError("UNAUTHENTICATED");
    await platform.auth.verifyMfa(token, body.code, meta);
    return { ok: true };
  },
});
