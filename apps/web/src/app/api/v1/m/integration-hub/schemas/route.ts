import { route } from "@/lib/api";
import { IH_MODULE, ih } from "@/lib/integration";

export const GET = route({ auth: "any", module: IH_MODULE, permission: "integration.read", handler: async ({ platform }) => ih(platform).schemas() });
