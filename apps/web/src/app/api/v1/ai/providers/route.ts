import { z } from "zod";
import { route } from "@/lib/api";

export const GET = route({ auth: "any", permission: "ai.provider.read", handler: ({ platform, ctx }) => platform.ai.listProviders(ctx) });
export const POST = route({ auth: "session", permission: "ai.provider.manage", body: z.record(z.unknown()), handler: ({ platform, ctx, body }) => platform.ai.configureProvider(ctx, body as never) });
