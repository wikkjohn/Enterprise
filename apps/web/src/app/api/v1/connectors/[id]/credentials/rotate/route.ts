import { z } from "zod";
import { route } from "@/lib/api";

export const POST = route({ auth: "session", status: 200, body: z.object({ values: z.record(z.string()) }), handler: ({ platform, ctx, params, body }) => platform.connectors.rotateCredentials(ctx, params.id!, body.values) });
