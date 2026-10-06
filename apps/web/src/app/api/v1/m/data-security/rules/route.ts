import { route } from "@/lib/api";
import { DS_MODULE, anyBody, ds } from "@/lib/data-security";

export const GET = route({ auth: "any", module: DS_MODULE, permission: "data_security.read", handler: ({ platform, ctx }) => ds(platform).listRules(ctx) });
export const POST = route({ auth: "session", module: DS_MODULE, permission: "data_security.classification.manage", body: anyBody, status: 200, handler: ({ platform, ctx, body }) => ds(platform).upsertRule(ctx, body) });
