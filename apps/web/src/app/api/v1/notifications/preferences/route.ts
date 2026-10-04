import { z } from "zod";
import { route } from "@/lib/api";

export const GET = route({ auth: "session", handler: ({ platform, ctx }) => platform.notifications.preferences(ctx) });
export const PUT = route({
  auth: "session",
  body: z.object({ type: z.string(), channel: z.enum(["in_app", "email", "webhook"]), enabled: z.boolean() }),
  handler: async ({ platform, ctx, body }) => {
    await platform.notifications.setPreference(ctx, body.type, body.channel, body.enabled);
    return { ok: true };
  },
});
