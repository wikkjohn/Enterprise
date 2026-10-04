import { z } from "zod";
import { route } from "@/lib/api";

export const POST = route({
  auth: "session_any",
  allowDuringMfaEnrollment: true,
  body: z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(1).max(256) }),
  status: 200,
  handler: async ({ platform, body, session, meta }) => {
    await platform.auth.changePassword(session!.user.id, session!.session.id, body.currentPassword, body.newPassword, meta);
    return { ok: true };
  },
});
