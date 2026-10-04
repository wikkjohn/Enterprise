import { route } from "@/lib/api";

export const POST = route({ auth: "any", status: 200, rateLimit: { limit: 20, windowSeconds: 60 }, handler: ({ platform, ctx, params }) => platform.connectors.test(ctx, params.id!) });
