import { route } from "@/lib/api";
import { anyBody, MODULE, wi } from "@/lib/workflow";

export const POST = route({ auth: "any", module: MODULE, permission: "workflow.roi.manage", body: anyBody, status: 201, handler: async ({ platform, ctx, params, body }) => { await wi(platform).recordBaseline(ctx, params.id!, body as never); return { saved: true }; } });
