import { route } from "@/lib/api";

export const DELETE = route({
  auth: "session",
  permission: "notification.manage",
  handler: async ({ platform, ctx, params }) => {
    await platform.events.webhooks.remove(ctx, params.id!);
    return { ok: true };
  },
});
