import { route } from "@/lib/api";

export const GET = route({ auth: "any", permission: "role.read", handler: async ({ platform }) => platform.rbac.registry.list() });
