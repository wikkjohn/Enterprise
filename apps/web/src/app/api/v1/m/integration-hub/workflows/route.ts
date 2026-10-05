import { route } from "@/lib/api";
import { anyBody, IH_MODULE, ih } from "@/lib/integration";

export const GET = route({ auth: "any", module: IH_MODULE, permission: "integration.read", handler: ({ platform, ctx }) => ih(platform).listWorkflows(ctx) });
export const POST = route({ auth: "session", module: IH_MODULE, permission: "integration.create", body: anyBody, status: 201, handler: ({ platform, ctx, body }) => ih(platform).createWorkflow(ctx, body) });
