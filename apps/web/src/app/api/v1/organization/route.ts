import { z } from "zod";
import { route } from "@/lib/api";

export const GET = route({ auth: "any", permission: "org.read", handler: ({ platform, ctx }) => platform.organizations.get(ctx) });
export const PATCH = route({
  auth: "session",
  permission: "org.manage",
  body: z.object({ name: z.string().min(2).max(160).optional(), primaryDomain: z.string().max(253).nullable().optional() }),
  handler: ({ platform, ctx, body }) => platform.organizations.update(ctx, body),
});
