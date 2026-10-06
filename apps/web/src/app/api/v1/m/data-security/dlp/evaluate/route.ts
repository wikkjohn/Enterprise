import { route } from "@/lib/api";
import { DS_MODULE, anyBody, ds } from "@/lib/data-security";

/** Enforcement-point API: content headed to an external AI destination → ALLOW | REDACT (redacted content returned) | REQUIRE_APPROVAL | BLOCK. */
export const POST = route({ auth: "any", module: DS_MODULE, permission: "data_security.scan", body: anyBody, status: 200, rateLimit: { limit: 600, windowSeconds: 60 }, handler: ({ platform, ctx, body }) => ds(platform).evaluate(ctx, body) });
