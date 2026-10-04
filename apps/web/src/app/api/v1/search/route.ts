import { z } from "zod";
import { route } from "@/lib/api";

export const GET = route({
  auth: "session",
  permission: "search.use",
  rateLimit: { limit: 120, windowSeconds: 60 },
  query: z.object({ q: z.string().max(200).default(""), types: z.string().max(500).optional() }),
  handler: ({ platform, ctx, query }) => platform.search.query(ctx, query.q, { types: query.types?.split(",").filter(Boolean) }),
});
