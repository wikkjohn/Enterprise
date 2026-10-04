import { route } from "@/lib/api";

export const GET = route({ auth: "any", permission: "org.read", handler: ({ platform, ctx }) => platform.organizations.settings(ctx) });
