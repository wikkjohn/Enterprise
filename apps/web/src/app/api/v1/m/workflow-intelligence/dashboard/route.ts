import { route } from "@/lib/api";
import { dataClassQuery, MODULE, wi } from "@/lib/workflow";

export const GET = route({ auth: "any", module: MODULE, permission: "workflow.read", query: dataClassQuery, handler: ({ platform, ctx, query }) => wi(platform).dashboard(ctx, query) });
