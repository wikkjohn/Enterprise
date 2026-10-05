import { route } from "@/lib/api";
import { anyBody, IH_MODULE, ih } from "@/lib/integration";

export const POST = route({ auth: "session", module: IH_MODULE, permission: "integration.approve", body: anyBody, status: 200, handler: ({ platform, ctx, params, body }) => ih(platform).decideApproval(ctx, params.id!, body) });
