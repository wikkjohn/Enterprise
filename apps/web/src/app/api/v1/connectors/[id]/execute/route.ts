import { z } from "zod";
import { route } from "@/lib/api";

export const POST = route({
  auth: "any",
  idempotent: true,
  status: 200,
  body: z.object({ capability: z.string(), operation: z.enum(["read", "list", "search", "write", "delete", "execute", "subscribe"]), params: z.record(z.unknown()).default({}) }),
  handler: ({ platform, ctx, params, body }) => platform.connectors.execute(ctx, params.id!, body),
});
