import { route } from "@/lib/api";
import { KV_MODULE, kv } from "@/lib/knowledge";

export const POST = route({ auth: "session", module: KV_MODULE, permission: "knowledge.manage", status: 200, rateLimit: { limit: 10, windowSeconds: 60 }, handler: ({ platform, ctx }) => kv(platform).runFreshnessScan(ctx) });
