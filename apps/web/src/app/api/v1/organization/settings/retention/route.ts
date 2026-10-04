import { z } from "zod";
import { route } from "@/lib/api";

export const PATCH = route({ auth: "session", permission: "org.security.manage", body: z.record(z.unknown()), handler: ({ platform, ctx, body }) => platform.organizations.updateRetention(ctx, body as never) });
