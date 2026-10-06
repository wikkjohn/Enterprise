import { route } from "@/lib/api";
import { DS_MODULE, anyBody, ds } from "@/lib/data-security";

/** Applies platform-internal actions; source-system permission changes are never automated and need an attestation note. */
export const POST = route({ auth: "session", module: DS_MODULE, permission: "data_security.remediation.manage", body: anyBody, status: 200, handler: ({ platform, ctx, params, body }) => ds(platform).completeRemediation(ctx, params.id!, body) });
