import { z } from "zod";
import { route } from "@/lib/api";

export const PATCH = route({ auth: "session", permission: "org.manage", body: z.record(z.unknown()), handler: ({ platform, ctx, body }) => platform.organizations.updateUsageLimits(ctx, body as never) });
