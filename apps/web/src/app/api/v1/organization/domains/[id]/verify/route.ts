import { route } from "@/lib/api";

export const POST = route({ auth: "session", permission: "org.manage", status: 200, handler: ({ platform, ctx, params }) => platform.organizations.verifyDomain(ctx, params.id!) });
