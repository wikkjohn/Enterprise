import { serializeCookie } from "@eaop/api";
import { AppError } from "@eaop/shared-types";
import { route } from "@/lib/api";

export const GET = route({
  auth: "public",
  rateLimit: { limit: 20, windowSeconds: 60 },
  handler: async ({ platform, req }) => {
    const idp = new URL(req.url).searchParams.get("idp");
    if (!idp) throw new AppError("VALIDATION_FAILED", "idp is required.");
    const { authorizationUrl, state } = await platform.sso.startLogin(idp);
    return new Response(null, {
      status: 302,
      headers: {
        location: authorizationUrl,
        "set-cookie": serializeCookie("eaop_sso_state", state, { httpOnly: true, secure: process.env.APP_ENV === "production", sameSite: "lax", path: "/api/v1/auth/sso", maxAge: 600 }),
      },
    });
  },
});
