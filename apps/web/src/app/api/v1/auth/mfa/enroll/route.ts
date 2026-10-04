import { route } from "@/lib/api";

export const POST = route({
  auth: "session_any",
  allowDuringMfaEnrollment: true,
  status: 200,
  handler: async ({ platform, session }) => platform.auth.beginMfaEnrollment(session!.user.id),
});
