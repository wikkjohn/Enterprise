import { serializeCookie } from "@eaop/api";
import { AppError } from "@eaop/shared-types";
import { route, SESSION_MAX_AGE, sessionCookies } from "@/lib/api";

export const GET = route({
  auth: "public",
  rateLimit: { limit: 20, windowSeconds: 60 },
  handler: async ({ platform, req, cookies, meta }) => {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const stateCookie = cookies["eaop_sso_state"];
    if (!code || !state || !stateCookie) throw new AppError("UNAUTHENTICATED", "Missing SSO parameters.");
    const { token } = await platform.sso.completeOidc({ code, state, stateCookie }, meta);
    const headers = new Headers({ location: "/" });
    sessionCookies(token, SESSION_MAX_AGE).forEach((c) => headers.append("set-cookie", c));
    headers.append("set-cookie", serializeCookie("eaop_sso_state", "", { httpOnly: true, path: "/api/v1/auth/sso", maxAge: 0 }));
    return new Response(null, { status: 302, headers });
  },
});
