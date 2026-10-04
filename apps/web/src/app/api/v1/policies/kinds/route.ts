import { route } from "@/lib/api";

export const GET = route({ auth: "any", permission: "policy.read", handler: async ({ platform }) => platform.policies.kinds() });
