import { z } from "zod";
import { route } from "@/lib/api";

export const GET = route({ auth: "any", permission: "org.read", handler: ({ platform, ctx }) => platform.organizations.listDomains(ctx) });
export const POST = route({ auth: "session", permission: "org.manage", body: z.object({ domain: z.string().max(253) }), handler: ({ platform, ctx, body }) => platform.organizations.addDomain(ctx, body.domain) });
