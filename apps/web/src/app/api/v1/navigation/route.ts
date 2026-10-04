import { route } from "@/lib/api";

export const GET = route({ auth: "session", handler: ({ platform, ctx }) => platform.modules.navigation(ctx) });
