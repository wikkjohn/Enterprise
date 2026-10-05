import { z } from "zod";
import { route } from "@/lib/api";
import { MODULE, wi } from "@/lib/workflow";

export const POST = route({ auth: "any", module: MODULE, permission: "workflow.create", body: z.object({ csv: z.string().max(2_000_000), dataClass: z.enum(["production", "sample"]).optional() }), handler: ({ platform, ctx, body }) => wi(platform).importCsv(ctx, body.csv, { dataClass: body.dataClass }) });
