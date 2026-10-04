import { z } from "zod";
import { route } from "@/lib/api";

export const GET = route({ auth: "any", permission: "notification.manage", handler: ({ platform, ctx }) => platform.events.webhooks.list(ctx) });
export const POST = route({
  auth: "session",
  permission: "notification.manage",
  body: z.object({ url: z.string().url(), eventTypes: z.array(z.string()).min(1).max(100), description: z.string().max(500).optional() }),
  handler: ({ platform, ctx, body }) => platform.events.webhooks.create(ctx, body),
});
