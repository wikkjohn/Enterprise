import { z } from "zod";
import { route } from "@/lib/api";

export const PUT = route({
  auth: "session",
  permission: "module.manage",
  body: z.object({ enabled: z.boolean() }),
  handler: async ({ platform, ctx, params, body }) => {
    await platform.modules.setFlag(ctx, params.key!, body.enabled);
    return { key: params.key, enabled: body.enabled };
  },
});
