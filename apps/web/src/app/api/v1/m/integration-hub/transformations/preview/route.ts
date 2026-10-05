import { route } from "@/lib/api";
import { anyBody, IH_MODULE, ih } from "@/lib/integration";

export const POST = route({ auth: "any", module: IH_MODULE, permission: "integration.read", body: anyBody, status: 200, handler: ({ platform, ctx, body }) => ih(platform).previewMappings(ctx, body) });
