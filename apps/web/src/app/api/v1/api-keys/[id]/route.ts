import { route } from "@/lib/api";

export const DELETE = route({
  auth: "session",
  permission: "apikey.manage",
  handler: async ({ platform, ctx, params }) => {
    await platform.apiKeys.revoke(ctx, params.id!);
    return { ok: true };
  },
});
