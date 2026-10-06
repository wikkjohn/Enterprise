import { route } from "@/lib/api";
import { DS_MODULE, anyBody, ds } from "@/lib/data-security";

export const GET = route({ auth: "any", module: DS_MODULE, permission: "data_security.incident.read", handler: ({ platform, ctx, params }) => ds(platform).getIncident(ctx, params.id!) });
export const PATCH = route({ auth: "session", module: DS_MODULE, permission: "data_security.incident.manage", body: anyBody, handler: ({ platform, ctx, params, body }) => ds(platform).updateIncident(ctx, params.id!, body) });
