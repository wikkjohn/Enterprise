import { route } from "@/lib/api";
import { anyBody, MODULE, wi } from "@/lib/workflow";

export const GET = route({ auth: "any", module: MODULE, permission: "workflow.read", handler: ({ platform, ctx, params }) => wi(platform).get(ctx, params.id!) });
export const PATCH = route({ auth: "any", module: MODULE, permission: "workflow.update", body: anyBody, handler: ({ platform, ctx, params, body }) => wi(platform).update(ctx, params.id!, body as never) });
export const DELETE = route({ auth: "any", module: MODULE, permission: "workflow.delete", handler: async ({ platform, ctx, params }) => { await wi(platform).remove(ctx, params.id!); return { deleted: true }; } });
