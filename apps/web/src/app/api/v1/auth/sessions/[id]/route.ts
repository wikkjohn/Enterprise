import { route } from "@/lib/api";

export const DELETE = route({
  auth: "session_any",
  allowDuringMfaEnrollment: true,
  handler: async ({ platform, session, params, meta }) => {
    await platform.auth.revokeSession(session!.user.id, params.id!, meta);
    return { ok: true };
  },
});
