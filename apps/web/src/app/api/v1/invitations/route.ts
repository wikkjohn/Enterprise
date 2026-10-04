import { z } from "zod";
import { route } from "@/lib/api";

export const GET = route({ auth: "any", permission: "user.read", handler: ({ platform, ctx }) => platform.organizations.listInvitations(ctx) });
export const POST = route({
  auth: "session",
  permission: "user.invite",
  body: z.object({ email: z.string().email(), roleKeys: z.array(z.string()).min(1).max(10) }),
  handler: async ({ platform, ctx, body }) => {
    const inv = await platform.organizations.invite(ctx, body);
    // The acceptance link is returned once so an administrator can share it when email is not configured.
    return { invitationId: inv.invitationId, expiresAt: inv.expiresAt, acceptUrl: `${platform.env.APP_URL}/invite/${inv.token}` };
  },
});
