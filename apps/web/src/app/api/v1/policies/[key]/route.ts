import { route } from "@/lib/api";

export const GET = route({ auth: "any", permission: "policy.read", handler: ({ platform, ctx, params }) => platform.policies.get(ctx, params.key!) });
