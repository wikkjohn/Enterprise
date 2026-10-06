import { route } from "@/lib/api";
import { DS_MODULE, anyBody, ds } from "@/lib/data-security";

export const GET = route({ auth: "any", module: DS_MODULE, permission: "data_security.read", handler: ({ platform, ctx }) => ds(platform).listScans(ctx) });
export const POST = route({ auth: "any", module: DS_MODULE, permission: "data_security.scan", body: anyBody, rateLimit: { limit: 20, windowSeconds: 60 }, handler: ({ platform, ctx, body }) => ds(platform).startScan(ctx, body) });
