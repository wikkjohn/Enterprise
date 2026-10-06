import { z } from "zod";
import { route } from "@/lib/api";
import { anyBody, IH_MODULE, ih } from "@/lib/integration";

export const GET = route({ auth: "any", module: IH_MODULE, permission: "integration.read", query: z.object({ status: z.string().max(20).optional(), q: z.string().max(200).optional() }), handler: ({ platform, ctx, query }) => ih(platform).listActions(ctx, query) });
export const POST = route({ auth: "session", module: IH_MODULE, permission: "integration.manage", body: anyBody, status: 201, handler: ({ platform, ctx, body }) => ih(platform).installTemplate(ctx, body) });
