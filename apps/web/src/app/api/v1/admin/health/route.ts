import { route } from "@/lib/api";

export const GET = route({ auth: "session", permission: "observability.read", handler: ({ platform, ctx }) => platform.health.report(ctx) });
