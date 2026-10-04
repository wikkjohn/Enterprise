import { auditQuerySchema } from "@eaop/audit";
import { route } from "@/lib/api";

export const GET = route({ auth: "any", permission: "audit.read", query: auditQuerySchema, handler: ({ platform, ctx, query }) => platform.audit.query(ctx, query) });
