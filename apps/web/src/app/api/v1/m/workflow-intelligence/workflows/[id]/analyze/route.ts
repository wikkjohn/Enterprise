import { route } from "@/lib/api";
import { MODULE, wi } from "@/lib/workflow";

export const POST = route({ auth: "any", module: MODULE, permission: "workflow.analyze", status: 200, handler: ({ platform, ctx, params }) => wi(platform).analyze(ctx, params.id!) });
