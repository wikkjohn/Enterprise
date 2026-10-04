import { z } from "zod";
import { route } from "@/lib/api";

export const POST = route({
  auth: "session",
  permission: "role.manage",
  body: z.object({ membershipId: z.string().uuid(), roleKey: z.string(), scopeType: z.enum(["module", "resource"]).optional(), scopeId: z.string().max(200).optional() }),
  handler: ({ platform, ctx, body }) => platform.rbac.roles.assign(ctx, body),
});
