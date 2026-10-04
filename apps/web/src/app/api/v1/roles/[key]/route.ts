import { z } from "zod";
import { route } from "@/lib/api";

export const PUT = route({
  auth: "session",
  permission: "role.manage",
  body: z.object({ permissions: z.array(z.string()).max(500) }),
  handler: ({ platform, ctx, params, body }) => platform.rbac.roles.updateRolePermissions(ctx, params.key!, body.permissions),
});
export const DELETE = route({
  auth: "session",
  permission: "role.manage",
  handler: async ({ platform, ctx, params }) => {
    await platform.rbac.roles.deleteRole(ctx, params.key!);
    return { ok: true };
  },
});
