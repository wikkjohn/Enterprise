import { route } from "@/lib/api";
import { MODULE, wi } from "@/lib/workflow";

export const GET = route({ auth: "any", module: MODULE, permission: "workflow.read", handler: ({ platform, ctx, params }) => wi(platform).listVersions(ctx, params.id!) });
