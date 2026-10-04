import { route } from "@/lib/api";

export const GET = route({ auth: "session_any", allowDuringMfaEnrollment: true, handler: async ({ platform, session }) => (await platform.auth.listSessions(session!.user.id)).map((s) => ({ ...s, current: s.id === session!.session.id })) });
