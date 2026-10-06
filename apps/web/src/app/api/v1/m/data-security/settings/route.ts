import { route } from "@/lib/api";
import { DS_MODULE, anyBody, ds } from "@/lib/data-security";

export const GET = route({ auth: "any", module: DS_MODULE, permission: "data_security.read", handler: ({ platform, ctx }) => ds(platform).getSettings(ctx) });
export const PATCH = route({ auth: "session", module: DS_MODULE, permission: "data_security.policy.manage", body: anyBody, handler: ({ platform, ctx, body }) => ds(platform).updateSettings(ctx, body) });
