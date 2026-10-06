import { route } from "@/lib/api";
import { DS_MODULE, anyBody, ds } from "@/lib/data-security";

/** Try detection and redaction on sample text. Nothing is stored. */
export const POST = route({ auth: "session", module: DS_MODULE, permission: "data_security.read", body: anyBody, status: 200, rateLimit: { limit: 60, windowSeconds: 60 }, handler: ({ platform, ctx, body }) => ds(platform).testDetection(ctx, body) });
