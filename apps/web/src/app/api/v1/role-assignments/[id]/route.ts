import { route } from "@/lib/api";

export const DELETE = route({
  auth: "session",
  permission: "role.manage",
  handler: async ({ platform, ctx, params }) => {
    await platform.rbac.roles.revoke(ctx, params.id!);
    return { ok: true };
  },
});
