import { z } from "zod";
import { AppError } from "@eaop/shared-types";
import { route } from "@/lib/api";

export const PATCH = route({
  auth: "session_any",
  body: z.object({ status: z.enum(["active", "suspended", "archived"]) }),
  handler: async ({ platform, session, meta, body, params }) => {
    if (!session?.user.isPlatformAdmin) throw new AppError("FORBIDDEN");
    return platform.organizations.setStatus({ actor: { type: "user", id: session.user.id, label: session.user.email, isPlatformAdmin: true }, ...meta }, params.id!, body.status);
  },
});
