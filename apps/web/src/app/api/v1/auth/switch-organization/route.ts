import { z } from "zod";
import { route } from "@/lib/api";

export const POST = route({
  auth: "session_any",
  body: z.object({ organizationId: z.string().uuid() }),
  status: 200,
  handler: async ({ platform, body, session, meta }) => {
    await platform.auth.switchOrganization(session!.token, body.organizationId, meta);
    return { ok: true };
  },
});
