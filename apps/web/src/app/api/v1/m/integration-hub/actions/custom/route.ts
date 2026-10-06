import { route } from "@/lib/api";
import { anyBody, IH_MODULE, ih } from "@/lib/integration";

export const POST = route({ auth: "session", module: IH_MODULE, permission: "integration.admin", body: anyBody, status: 201, handler: ({ platform, ctx, body }) => ih(platform).createCustomAction(ctx, body) });
