import { route } from "@/lib/api";
import { anyBody, IH_MODULE, ih } from "@/lib/integration";

export const GET = route({ auth: "any", module: IH_MODULE, permission: "integration.read", handler: ({ platform, ctx, params }) => ih(platform).getWorkflow(ctx, params.id!) });
export const PATCH = route({ auth: "session", module: IH_MODULE, permission: "integration.create", body: anyBody, handler: ({ platform, ctx, params, body }) => ih(platform).updateWorkflow(ctx, params.id!, body) });
