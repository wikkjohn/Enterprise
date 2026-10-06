import { route } from "@/lib/api";
import { DS_MODULE, anyBody, ds } from "@/lib/data-security";

export const POST = route({ auth: "session", module: DS_MODULE, permission: "data_security.policy.manage", body: anyBody, status: 200, handler: ({ platform, ctx, params, body }) => ds(platform).setToolStatus(ctx, params.id!, body) });
