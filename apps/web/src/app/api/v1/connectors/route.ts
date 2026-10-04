import { z } from "zod";
import { route } from "@/lib/api";

export const GET = route({ auth: "any", permission: "connector.read", handler: ({ platform, ctx }) => platform.connectors.list(ctx) });
export const POST = route({
  auth: "any",
  permission: "connector.manage",
  idempotent: true,
  body: z.object({ type: z.string(), name: z.string(), description: z.string().optional(), authType: z.enum(["oauth2", "api_key", "service_account", "basic", "none"]), config: z.record(z.unknown()).default({}), capabilities: z.array(z.string()).optional() }),
  handler: ({ platform, ctx, body }) => platform.connectors.create(ctx, body),
});
