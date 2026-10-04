import { route } from "@/lib/api";

export const GET = route({ auth: "any", permission: "module.read", handler: ({ platform, ctx }) => platform.modules.listFlags(ctx) });
