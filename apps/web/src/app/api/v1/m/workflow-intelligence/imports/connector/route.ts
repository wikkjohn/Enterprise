import { route } from "@/lib/api";
import { anyBody, MODULE, wi } from "@/lib/workflow";

export const POST = route({ auth: "any", module: MODULE, permission: "workflow.create", body: anyBody, handler: ({ platform, ctx, body }) => wi(platform).importFromConnector(ctx, body as never) });
