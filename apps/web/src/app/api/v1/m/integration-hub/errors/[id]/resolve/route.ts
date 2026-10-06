import { route } from "@/lib/api";
import { IH_MODULE, ih } from "@/lib/integration";

export const POST = route({ auth: "session", module: IH_MODULE, permission: "integration.manage", status: 200, handler: ({ platform, ctx, params }) => ih(platform).resolveError(ctx, params.id!) });
