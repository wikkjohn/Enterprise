import { AppError } from "@eaop/shared-types";
import { route } from "@/lib/api";

// Top-level redirect from the provider: SameSite=Lax cookies are sent, no CSRF token (GET). State is HMAC-signed and org-bound.
export const GET = route({
  auth: "session",
  handler: async ({ platform, ctx, req }) => {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) throw new AppError("VALIDATION_FAILED", "Missing OAuth parameters.");
    const c = await platform.connectors.completeOAuth(ctx, { code, state });
    return new Response(null, { status: 302, headers: { location: `/admin/connectors/${c.id}?oauth=connected` } });
  },
});
