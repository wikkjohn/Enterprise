import { route } from "@/lib/api";

export const POST = route({ auth: "session", permission: "module.manage", status: 200, handler: ({ platform, ctx, params }) => platform.modules.disable(ctx, params.id!) });
