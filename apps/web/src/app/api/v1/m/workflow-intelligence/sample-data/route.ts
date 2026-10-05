import { route } from "@/lib/api";
import { MODULE, wi } from "@/lib/workflow";

export const POST = route({ auth: "session", module: MODULE, permission: "workflow.create", handler: ({ platform, ctx }) => wi(platform).loadSampleData(ctx) });
export const DELETE = route({ auth: "session", module: MODULE, permission: "workflow.delete", handler: ({ platform, ctx }) => wi(platform).clearSampleData(ctx) });
