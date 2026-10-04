import { route } from "@/lib/api";

export const GET = route({ auth: "session", handler: async ({ platform, ctx }) => ({ count: await platform.notifications.unreadCount(ctx) }) });
