import { route } from "@/lib/api";

export const POST = route({ auth: "session", permission: "policy.manage", status: 200, handler: ({ platform, ctx, params }) => platform.policies.disable(ctx, params.key!) });
