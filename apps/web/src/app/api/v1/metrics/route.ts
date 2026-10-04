import { AppError } from "@eaop/shared-types";
import { route } from "@/lib/api";

// Prometheus exposition. Process-wide metrics are platform-level, so this is restricted to platform administrators.
export const GET = route({
  auth: "session",
  handler: async ({ platform, ctx }) => {
    if (!ctx.actor.isPlatformAdmin) throw new AppError("FORBIDDEN");
    return new Response(platform.metrics.toPrometheus(), { status: 200, headers: { "content-type": "text/plain; version=0.0.4" } });
  },
});
