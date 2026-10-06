import { route } from "@/lib/api";
import { DS_MODULE, anyBody, ds } from "@/lib/data-security";

/** AI usage telemetry from proxies, CASB, SSO or browser logs. Only AI destinations are recorded. */
export const POST = route({ auth: "any", module: DS_MODULE, permission: "data_security.scan", body: anyBody, status: 200, rateLimit: { limit: 120, windowSeconds: 60 }, handler: ({ platform, ctx, body }) => ds(platform).ingestTelemetry(ctx, body) });
