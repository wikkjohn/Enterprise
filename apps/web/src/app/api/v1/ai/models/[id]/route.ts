import { z } from "zod";
import { route } from "@/lib/api";

export const PATCH = route({
  auth: "session",
  permission: "ai.provider.manage",
  body: z.object({ status: z.enum(["active", "disabled"]) }),
  handler: async ({ platform, ctx, params, body }) => {
    await platform.ai.setModelStatus(ctx, params.id!, body.status);
    return { ok: true };
  },
});
