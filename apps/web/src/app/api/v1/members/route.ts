import { z } from "zod";
import { route } from "@/lib/api";

export const GET = route({
  auth: "any",
  permission: "user.read",
  query: z.object({ search: z.string().max(100).optional(), status: z.enum(["active", "suspended", "invited"]).optional() }),
  handler: ({ platform, ctx, query }) => platform.organizations.listMembers(ctx, query),
});
