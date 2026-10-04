import { z } from "zod";
import { route } from "@/lib/api";

export const POST = route({
  auth: "public",
  rateLimit: { limit: 20, windowSeconds: 60 },
  body: z.object({ email: z.string().email().max(320) }),
  status: 200,
  handler: async ({ platform, body }) => {
    const idp = await platform.sso.discover(body.email);
    return idp ? { sso: true, idpId: idp.idpId, name: idp.name, protocol: idp.protocol } : { sso: false };
  },
});
