import { z } from "zod";
import { route } from "@/lib/api";

export const POST = route({
  auth: "session_any",
  allowDuringMfaEnrollment: true,
  body: z.object({ code: z.string().regex(/^\d{6}$/) }),
  status: 200,
  handler: async ({ platform, session, body, meta }) => {
    await platform.auth.confirmMfaEnrollment(session!.user.id, body.code, meta);
    return { ok: true };
  },
});
