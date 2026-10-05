import { route } from "@/lib/api";
import { anyBody, MODULE, wi } from "@/lib/workflow";

export const PUT = route({ auth: "any", module: MODULE, permission: "workflow.update", body: anyBody, handler: ({ platform, ctx, params, body }) => wi(platform).saveGraph(ctx, params.id!, body as never) });
