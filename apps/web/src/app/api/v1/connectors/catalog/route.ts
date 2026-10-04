import { route } from "@/lib/api";

export const GET = route({ auth: "any", permission: "connector.read", handler: async ({ platform }) => platform.connectors.catalog() });
