import { route } from "@/lib/api";
import { IH_MODULE, ih } from "@/lib/integration";

export const POST = route({ auth: "any", module: IH_MODULE, permission: "integration.execute", status: 200, handler: ({ platform, ctx, params }) => ih(platform).cancelExecution(ctx, params.id!) });
