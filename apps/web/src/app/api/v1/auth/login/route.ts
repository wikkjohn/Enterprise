import { z } from "zod";
import { RATE_LIMITS } from "@eaop/security";
import { route, SESSION_MAX_AGE, sessionCookies } from "@/lib/api";

export const POST = route({
  auth: "public",
  rateLimit: RATE_LIMITS.login,
  body: z.object({ email: z.string().email().max(320), password: z.string().min(1).max(256) }),
  status: 200,
  handler: async ({ platform, body, meta, setCookie }) => {
    const r = await platform.auth.login(body, meta);
    sessionCookies(r.token, SESSION_MAX_AGE).forEach(setCookie);
    return { status: r.status, user: { id: r.user.id, email: r.user.email, name: r.user.name } };
  },
});
