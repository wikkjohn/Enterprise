import { route } from "@/lib/api";
import { KV_MODULE, kv } from "@/lib/knowledge";

export const GET = route({ auth: "any", module: KV_MODULE, permission: "knowledge.verification.read", handler: ({ platform, ctx }) => kv(platform).analytics(ctx) });
