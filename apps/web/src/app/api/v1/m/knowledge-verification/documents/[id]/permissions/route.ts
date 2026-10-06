import { route } from "@/lib/api";
import { KV_MODULE, anyBody, kv } from "@/lib/knowledge";

export const PUT = route({ auth: "session", module: KV_MODULE, permission: "knowledge.source.manage", body: anyBody, handler: ({ platform, ctx, params, body }) => kv(platform).setDocumentPermissions(ctx, params.id!, body) });
