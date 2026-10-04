import { clearSessionCookies, route } from "@/lib/api";

// Cookie-authenticated (CSRF-checked) so a third-party site cannot force a logout.
export const POST = route({
  auth: "session_any",
  allowDuringMfaEnrollment: true,
  status: 200,
  handler: async ({ platform, meta, session, setCookie }) => {
    await platform.auth.logout(session!.token, meta);
    clearSessionCookies().forEach(setCookie);
    return { ok: true };
  },
});
