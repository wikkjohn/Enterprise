import { route } from "@/lib/api";
import { MODULE, wi } from "@/lib/workflow";

export const POST = route({ auth: "any", module: MODULE, permission: "workflow.analyze", status: 201, handler: ({ platform, ctx, params }) => wi(platform).redesign(ctx, params.id!) });
