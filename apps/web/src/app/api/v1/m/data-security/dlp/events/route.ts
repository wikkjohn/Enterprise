import { route } from "@/lib/api";
import { DS_MODULE, ds, listQuery } from "@/lib/data-security";

export const GET = route({ auth: "any", module: DS_MODULE, permission: "data_security.incident.read", query: listQuery, handler: ({ platform, ctx, query }) => ds(platform).listDlpEvents(ctx, query) });
