import { z } from "zod";
import { route } from "@/lib/api";
import { IH_MODULE, ih } from "@/lib/integration";

export const GET = route({ auth: "any", module: IH_MODULE, permission: "integration.read", handler: ({ platform, ctx, params }) => ih(platform).getVersion(ctx, params.id!, z.coerce.number().int().min(1).parse(params.version)) });
