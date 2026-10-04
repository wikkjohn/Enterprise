import { usageSummarySchema } from "@eaop/usage";
import { route } from "@/lib/api";

export const GET = route({ auth: "any", permission: "usage.read", query: usageSummarySchema, handler: ({ platform, ctx, query }) => platform.usage.summary(ctx, query) });
