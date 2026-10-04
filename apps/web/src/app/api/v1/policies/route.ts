import { z } from "zod";
import { route } from "@/lib/api";

export const GET = route({ auth: "any", permission: "policy.read", handler: ({ platform, ctx }) => platform.policies.list(ctx) });
export const POST = route({ auth: "session", permission: "policy.manage", body: z.record(z.unknown()), handler: ({ platform, ctx, body }) => platform.policies.create(ctx, body as never) });
