import { z } from "zod";
import { route } from "@/lib/api";
import { MODULE, wi } from "@/lib/workflow";

export const POST = route({ auth: "any", module: MODULE, permission: "workflow.create", idempotent: true, body: z.object({ records: z.array(z.unknown()).min(1).max(1000), dataClass: z.enum(["production", "sample"]).optional() }), handler: ({ platform, ctx, body }) => wi(platform).importRecords(ctx, body.records, { dataClass: body.dataClass }) });
