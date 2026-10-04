import { route } from "@/lib/api";

export const DELETE = route({
  auth: "session",
  permission: "user.invite",
  handler: async ({ platform, ctx, params }) => {
    await platform.organizations.revokeInvitation(ctx, params.id!);
    return { ok: true };
  },
});
