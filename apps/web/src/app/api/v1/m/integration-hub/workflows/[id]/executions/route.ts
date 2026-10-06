import { route } from "@/lib/api";
import { anyBody, IH_MODULE, ih } from "@/lib/integration";

/** Start a run. API-key callers are recorded as trigger "api"; browser sessions as "manual". */
export const POST = route({
  auth: "any", module: IH_MODULE, permission: "integration.execute", body: anyBody, status: 202, idempotent: true,
  handler: ({ platform, ctx, params, body, req }) => ih(platform).startExecution(ctx, params.id!, { ...body, idempotencyKey: (body.idempotencyKey as string | undefined) ?? req.headers.get("idempotency-key") ?? undefined }, ctx.actor.type === "api_key" ? "api" : "manual"),
});
