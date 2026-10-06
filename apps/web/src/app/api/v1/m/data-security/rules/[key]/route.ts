import { route } from "@/lib/api";
import { DS_MODULE, ds } from "@/lib/data-security";

export const DELETE = route({ auth: "session", module: DS_MODULE, permission: "data_security.classification.manage", handler: ({ platform, ctx, params }) => ds(platform).deleteRule(ctx, params.key!) });
