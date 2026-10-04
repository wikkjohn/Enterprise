import { z } from "zod";
import { AppError } from "@eaop/shared-types";
import { createOrganizationSchema } from "@eaop/organizations";
import { route } from "@/lib/api";

export const GET = route({
  auth: "session_any",
  handler: async ({ platform, session, meta }) => {
    if (!session?.user.isPlatformAdmin) throw new AppError("FORBIDDEN");
    return platform.organizations.listAll({ actor: { type: "user", id: session.user.id, label: session.user.email, isPlatformAdmin: true }, ...meta });
  },
});

export const POST = route({
  auth: "session_any",
  body: createOrganizationSchema.extend({ adminUserId: z.string().uuid().optional() }),
  handler: async ({ platform, session, meta, body }) => {
    if (!session?.user.isPlatformAdmin) throw new AppError("FORBIDDEN");
    return platform.organizations.create({ actor: { type: "user", id: session.user.id, label: session.user.email, isPlatformAdmin: true }, ...meta }, { ...body, adminUserId: body.adminUserId ?? session.user.id });
  },
});
