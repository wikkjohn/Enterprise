import { route } from "@/lib/api";
import { anyBody, IH_MODULE, ih } from "@/lib/integration";

/** AI tool gateway. Organization and caller come from authentication — never from the body. */
export const POST = route({
  auth: "any", module: IH_MODULE, permission: "integration.execute", body: anyBody, status: 200, rateLimit: { limit: 120, windowSeconds: 60 },
  handler: ({ platform, ctx, params, body, req }) => ih(platform).invokeTool(ctx, params.name!, { ...body, idempotencyKey: (body.idempotencyKey as string | undefined) ?? req.headers.get("idempotency-key") ?? undefined }),
});
