import { route } from "@/lib/api";

export const GET = route({
  auth: "session_any",
  allowDuringMfaEnrollment: true,
  handler: async ({ platform, ctx, session }) => {
    const orgs = await platform.organizations.listForUser(session!.user.id);
    return {
      user: { id: session!.user.id, email: session!.user.email, name: session!.user.name, isPlatformAdmin: session!.user.isPlatformAdmin, mfaEnabled: session!.user.mfaEnabled },
      organizationId: ctx?.organizationId ?? null,
      organizations: orgs.map((o) => ({ id: o.id, name: o.name, slug: o.slug })),
      permissions: ctx ? await platform.rbac.authorizer.list(ctx) : [],
      navigation: ctx ? await platform.modules.navigation(ctx) : [],
    };
  },
});
