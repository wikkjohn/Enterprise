import { z } from "zod";
import { route } from "@/lib/api";

export const GET = route({ auth: "session", permission: "org.security.read", handler: ({ platform, ctx }) => platform.sso.list(ctx) });
export const POST = route({
  auth: "session",
  permission: "org.security.manage",
  body: z.object({ protocol: z.enum(["oidc", "saml"]) }).passthrough(),
  handler: ({ platform, ctx, body }) => (body.protocol === "oidc" ? platform.sso.configureOidc(ctx, body as never) : platform.sso.configureSaml(ctx, body as never)),
});
