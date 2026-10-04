import { route } from "@/lib/api";

export const GET = route({
  auth: "any",
  permission: "notification.manage",
  handler: async ({ platform }) => platform.events.registry.list().map((c) => ({ type: c.type, owner: c.owner, version: c.version, description: c.description, externallyVisible: c.externallyVisible !== false })),
});
