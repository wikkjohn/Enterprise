import { z } from "zod";
import { route } from "@/lib/api";

export const POST = route({
  auth: "session",
  permission: "ai.provider.manage",
  body: z.record(z.unknown()),
  handler: async ({ platform, ctx, params, body }) => {
    await platform.ai.upsertModel(ctx, params.id!, body as never);
    return { ok: true };
  },
});
