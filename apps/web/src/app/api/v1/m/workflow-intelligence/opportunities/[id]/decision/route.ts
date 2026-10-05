import { route } from "@/lib/api";
import { anyBody, MODULE, wi } from "@/lib/workflow";

export const POST = route({ auth: "any", module: MODULE, permission: "workflow.approve", body: anyBody, handler: ({ platform, ctx, params, body }) => wi(platform).decideOpportunity(ctx, params.id!, body as never) });
