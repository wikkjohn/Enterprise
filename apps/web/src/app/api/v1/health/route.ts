import { route } from "@/lib/api";

// Liveness/readiness probe for load balancers. No details are exposed.
export const GET = route({
  auth: "public",
  rateLimit: { limit: 600, windowSeconds: 60 },
  handler: async ({ platform }) => {
    const { ok } = await platform.health.probe();
    return new Response(JSON.stringify({ status: ok ? "ok" : "unavailable" }), { status: ok ? 200 : 503, headers: { "content-type": "application/json" } });
  },
});
