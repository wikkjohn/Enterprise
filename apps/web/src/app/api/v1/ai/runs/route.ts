import { z } from "zod";
import { route } from "@/lib/api";

export const GET = route({
  auth: "any",
  permission: "ai.run.read",
  query: z.object({ moduleId: z.string().max(64).optional(), status: z.string().max(32).optional(), limit: z.coerce.number().int().min(1).max(200).optional(), cursor: z.string().max(512).optional() }),
  handler: ({ platform, ctx, query }) => platform.ai.listRuns(ctx, query),
});
