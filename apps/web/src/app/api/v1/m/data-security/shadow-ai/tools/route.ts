import { route } from "@/lib/api";
import { DS_MODULE, anyBody, ds, listQuery } from "@/lib/data-security";

export const GET = route({ auth: "any", module: DS_MODULE, permission: "data_security.shadow_ai.read", query: listQuery, handler: ({ platform, ctx, query }) => ds(platform).listTools(ctx, query) });
export const POST = route({ auth: "session", module: DS_MODULE, permission: "data_security.policy.manage", body: anyBody, handler: ({ platform, ctx, body }) => ds(platform).createTool(ctx, body) });
