import { z } from "zod";
import { route } from "@/lib/api";
import { IH_MODULE, ih } from "@/lib/integration";

export const POST = route({ auth: "session", module: IH_MODULE, permission: "integration.manage", status: 200, body: z.object({ status: z.enum(["active", "paused", "archived"]) }), handler: ({ platform, ctx, params, body }) => ih(platform).setWorkflowStatus(ctx, params.id!, body.status) });
