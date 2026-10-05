import { route } from "@/lib/api";
import { anyBody, MODULE, wi } from "@/lib/workflow";

export const GET = route({ auth: "any", module: MODULE, permission: "workflow.read", handler: ({ platform, ctx, params }) => wi(platform).getImplementation(ctx, params.id!) });
export const PATCH = route({ auth: "any", module: MODULE, permission: "workflow.implementation.manage", body: anyBody, handler: ({ platform, ctx, params, body }) => wi(platform).updateImplementation(ctx, params.id!, body as never) });
