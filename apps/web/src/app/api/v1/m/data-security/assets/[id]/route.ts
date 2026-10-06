import { route } from "@/lib/api";
import { DS_MODULE, ds } from "@/lib/data-security";

export const GET = route({ auth: "any", module: DS_MODULE, permission: "data_security.read", handler: ({ platform, ctx, params }) => ds(platform).getAsset(ctx, params.id!) });
