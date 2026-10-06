import { route } from "@/lib/api";
import { DS_MODULE, anyBody, ds } from "@/lib/data-security";

/** Approve or reject an AI data transfer. People only; never your own request. */
export const POST = route({ auth: "session", module: DS_MODULE, permission: "data_security.policy.manage", body: anyBody, status: 200, handler: ({ platform, ctx, params, body }) => ds(platform).decideDlpApproval(ctx, params.id!, body) });
