import { route } from "@/lib/api";
import { KV_MODULE, kv } from "@/lib/knowledge";

/** Governance metadata (classification, authority, owner, access) for one document the caller can access. */
export const GET = route({ auth: "any", module: KV_MODULE, permission: "knowledge.read", handler: ({ platform, ctx, params }) => kv(platform).documentMetadata(ctx, params.id!) });
