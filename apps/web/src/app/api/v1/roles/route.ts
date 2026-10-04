import { z } from "zod";
import { route } from "@/lib/api";

export const GET = route({ auth: "any", permission: "role.read", handler: ({ platform, ctx }) => platform.rbac.roles.listRoles(ctx) });
export const POST = route({
  auth: "session",
  permission: "role.manage",
  body: z.object({ key: z.string(), name: z.string(), description: z.string().optional(), permissions: z.array(z.string()) }),
  handler: ({ platform, ctx, body }) => platform.rbac.roles.createRole(ctx, body),
});
