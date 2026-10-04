import { z } from "zod";
import { route } from "@/lib/api";

export const GET = route({
  auth: "session",
  query: z.object({ unreadOnly: z.enum(["true", "false"]).optional(), limit: z.coerce.number().int().min(1).max(100).optional(), cursor: z.string().max(512).optional() }),
  handler: ({ platform, ctx, query }) => platform.notifications.listMine(ctx, { unreadOnly: query.unreadOnly === "true", limit: query.limit, cursor: query.cursor }),
});
