import { route } from "@/lib/api";

export const GET = route({ auth: "any", permission: "ai.run.read", handler: ({ platform, ctx, params }) => platform.ai.getRun(ctx, params.id!) });
