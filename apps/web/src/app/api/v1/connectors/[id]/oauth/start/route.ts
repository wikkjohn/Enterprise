import { route } from "@/lib/api";

export const POST = route({ auth: "session", status: 200, handler: ({ platform, ctx, params }) => platform.connectors.startOAuth(ctx, params.id!) });
