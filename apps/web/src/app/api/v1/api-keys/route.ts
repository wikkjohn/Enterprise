import { z } from "zod";
import { route } from "@/lib/api";

export const GET = route({ auth: "session", permission: "apikey.read", handler: ({ platform, ctx }) => platform.apiKeys.list(ctx) });
export const POST = route({
  auth: "session",
  permission: "apikey.manage",
  body: z.object({ name: z.string().min(1).max(120), scopes: z.array(z.string()).min(1).max(100), expiresInDays: z.number().int().min(1).max(730).optional() }),
  handler: ({ platform, ctx, body }) => platform.apiKeys.create(ctx, body),
});
