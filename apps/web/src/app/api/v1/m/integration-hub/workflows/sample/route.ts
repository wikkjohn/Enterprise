import { route } from "@/lib/api";
import { IH_MODULE, ih } from "@/lib/integration";

export const POST = route({ auth: "session", module: IH_MODULE, permission: "integration.manage", status: 201, handler: ({ platform, ctx }) => ih(platform).createSample(ctx) });
