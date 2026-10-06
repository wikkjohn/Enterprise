import { route } from "@/lib/api";
import { DS_MODULE, anyBody, ds } from "@/lib/data-security";

/** Push asset inventory (metadata + optional content sample, classified in memory and discarded). */
export const POST = route({ auth: "any", module: DS_MODULE, permission: "data_security.scan", body: anyBody, status: 200, rateLimit: { limit: 60, windowSeconds: 60 }, handler: ({ platform, ctx, body }) => ds(platform).ingestAssets(ctx, body) });
