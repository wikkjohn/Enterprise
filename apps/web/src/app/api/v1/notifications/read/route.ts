import { z } from "zod";
import { route } from "@/lib/api";

export const POST = route({
  auth: "session",
  status: 200,
  body: z.object({ ids: z.union([z.array(z.string().uuid()).max(500), z.literal("all")]) }),
  handler: async ({ platform, ctx, body }) => {
    await platform.notifications.markRead(ctx, body.ids);
    return { ok: true };
  },
});
