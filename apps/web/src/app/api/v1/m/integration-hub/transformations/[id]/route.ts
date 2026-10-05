import { route } from "@/lib/api";
import { anyBody, IH_MODULE, ih } from "@/lib/integration";

export const PUT = route({ auth: "session", module: IH_MODULE, permission: "integration.create", body: anyBody, handler: ({ platform, ctx, params, body }) => ih(platform).saveTransformation(ctx, body, params.id!) });
