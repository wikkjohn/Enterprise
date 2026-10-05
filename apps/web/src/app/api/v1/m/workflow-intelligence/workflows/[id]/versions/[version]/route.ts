import { z } from "zod";
import { route } from "@/lib/api";
import { MODULE, wi } from "@/lib/workflow";

export const GET = route({ auth: "any", module: MODULE, permission: "workflow.read", handler: ({ platform, ctx, params }) => wi(platform).getVersion(ctx, params.id!, z.coerce.number().int().min(1).parse(params.version)) });
