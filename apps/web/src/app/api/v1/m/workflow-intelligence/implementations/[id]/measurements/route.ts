import { route } from "@/lib/api";
import { anyBody, MODULE, wi } from "@/lib/workflow";

export const POST = route({ auth: "any", module: MODULE, permission: "workflow.roi.manage", body: anyBody, status: 201, handler: ({ platform, ctx, params, body }) => wi(platform).recordMeasurement(ctx, params.id!, body as never) });
