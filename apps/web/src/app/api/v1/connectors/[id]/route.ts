import { z } from "zod";
import { route } from "@/lib/api";

export const GET = route({ auth: "any", handler: ({ platform, ctx, params }) => platform.connectors.get(ctx, params.id!) });
export const PATCH = route({ auth: "any", body: z.record(z.unknown()), handler: ({ platform, ctx, params, body }) => platform.connectors.update(ctx, params.id!, body as never) });
export const DELETE = route({
  auth: "any",
  handler: async ({ platform, ctx, params }) => {
    await platform.connectors.remove(ctx, params.id!);
    return { ok: true };
  },
});
