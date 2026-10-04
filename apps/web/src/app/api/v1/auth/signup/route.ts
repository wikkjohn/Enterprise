import { z } from "zod";
import { RATE_LIMITS } from "@eaop/security";
import { route, SESSION_MAX_AGE, sessionCookies } from "@/lib/api";

export const POST = route({
  auth: "public",
  rateLimit: RATE_LIMITS.login,
  body: z.object({ email: z.string().email(), name: z.string().min(1).max(160), password: z.string().max(256), organizationName: z.string().min(2).max(160), organizationSlug: z.string().max(48) }),
  handler: async ({ platform, body, meta, setCookie }) => {
    const r = await platform.auth.signup(body, meta);
    sessionCookies(r.token, SESSION_MAX_AGE).forEach(setCookie);
    return { status: r.status };
  },
});
