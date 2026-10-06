import { z } from "zod";
import { route } from "@/lib/api";
import { IH_MODULE, ih } from "@/lib/integration";

export const GET = route({ auth: "any", module: IH_MODULE, permission: "integration.history.read", query: z.object({ status: z.string().max(20).optional() }), handler: ({ platform, ctx, query }) => ih(platform).listErrors(ctx, query) });
