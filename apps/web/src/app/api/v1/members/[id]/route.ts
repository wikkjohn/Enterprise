import { z } from "zod";
import { route } from "@/lib/api";

export const PATCH = route({
  auth: "session",
  permission: "user.manage",
  body: z.object({ status: z.enum(["active", "suspended", "removed"]) }),
  handler: async ({ platform, ctx, params, body }) => {
    await platform.organizations.setMemberStatus(ctx, params.id!, body.status);
    return { ok: true };
  },
});
