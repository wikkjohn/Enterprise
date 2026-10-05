import { route } from "@/lib/api";
import { anyBody, MODULE, wi } from "@/lib/workflow";

export const PUT = route({ auth: "any", module: MODULE, permission: "workflow.update", body: anyBody, handler: async ({ platform, ctx, params, body }) => { await wi(platform).setMetrics(ctx, params.id!, body as never); return { saved: true }; } });
