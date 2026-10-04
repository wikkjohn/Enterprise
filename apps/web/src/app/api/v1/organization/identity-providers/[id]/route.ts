import { z } from "zod";
import { route } from "@/lib/api";

export const PATCH = route({
  auth: "session",
  permission: "org.security.manage",
  body: z.object({ status: z.enum(["active", "disabled"]) }),
  handler: async ({ platform, ctx, params, body }) => {
    await platform.sso.setStatus(ctx, params.id!, body.status);
    return { ok: true };
  },
});
