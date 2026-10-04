import { z } from "zod";
import { route } from "@/lib/api";

export const PUT = route({
  auth: "session",
  body: z.object({ values: z.record(z.string()), scopes: z.array(z.string()).optional(), expiresAt: z.coerce.date().optional(), rotationIntervalDays: z.number().int().optional() }),
  handler: ({ platform, ctx, params, body }) => platform.connectors.setCredentials(ctx, params.id!, body),
});
export const DELETE = route({ auth: "session", handler: ({ platform, ctx, params }) => platform.connectors.revokeCredentials(ctx, params.id!) });
