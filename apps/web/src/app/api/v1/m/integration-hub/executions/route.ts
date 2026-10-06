import { z } from "zod";
import { route } from "@/lib/api";
import { IH_MODULE, ih } from "@/lib/integration";

export const GET = route({ auth: "any", module: IH_MODULE, permission: "integration.history.read", query: z.object({ workflowId: z.string().max(64).optional(), status: z.string().max(30).optional(), mode: z.string().max(10).optional(), limit: z.coerce.number().int().min(1).max(200).optional(), cursor: z.string().max(500).optional() }), handler: ({ platform, ctx, query }) => ih(platform).listExecutions(ctx, query) });
