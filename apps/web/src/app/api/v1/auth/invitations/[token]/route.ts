import { z } from "zod";
import { AppError } from "@eaop/shared-types";
import { route, SESSION_MAX_AGE, sessionCookies } from "@/lib/api";

export const GET = route({
  auth: "public",
  rateLimit: { limit: 30, windowSeconds: 60 },
  handler: async ({ platform, params }) => {
    const inv = await platform.auth.describeInvitation(params.token!);
    if (!inv) throw new AppError("NOT_FOUND", "This invitation is invalid or has expired.");
    return inv;
  },
});

export const POST = route({
  auth: "public",
  rateLimit: { limit: 10, windowSeconds: 300 },
  body: z.object({ name: z.string().min(1).max(160), password: z.string().min(1).max(256) }),
  status: 200,
  handler: async ({ platform, params, body, meta, setCookie }) => {
    const r = await platform.auth.acceptInvitation({ token: params.token!, ...body }, meta);
    sessionCookies(r.token, SESSION_MAX_AGE).forEach(setCookie);
    return { status: r.status };
  },
});
