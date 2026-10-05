import { route } from "@/lib/api";
import { anyBody, IH_MODULE, ih } from "@/lib/integration";

export const GET = route({ auth: "any", module: IH_MODULE, permission: "integration.read", handler: ({ platform, ctx, params }) => ih(platform).getAction(ctx, params.id!) });
export const PATCH = route({ auth: "session", module: IH_MODULE, permission: "integration.manage", body: anyBody, handler: ({ platform, ctx, params, body }) => ih(platform).updateAction(ctx, params.id!, body) });
