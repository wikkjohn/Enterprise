import { PageHeader } from "@eaop/design-system";
import { ActionCatalog } from "@/components/integration/actions";
import { getPlatform } from "@/lib/platform";
import { ih } from "@/lib/integration";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Action catalog" };

export default async function ActionsPage() {
  const viewer = await requireViewer();
  const platform = await getPlatform();
  const svc = ih(platform);
  const [actions, templates, transformations] = await Promise.all([svc.listActions(viewer.ctx), svc.templates(viewer.ctx), svc.listTransformations(viewer.ctx)]);
  const restConnectors = can(viewer, "integration.admin") && can(viewer, "connector.read") ? (await platform.connectors.list(viewer.ctx)).filter((c) => c.type === "rest_api" && c.status !== "disabled").map((c) => ({ id: c.id, name: c.name })) : [];
  return (
    <div className="space-y-6">
      <PageHeader title="Action catalog" description="Business actions on shared connectors — each with a schema, validation, required permissions, risk, approval and idempotency settings." />
      <ActionCatalog actions={actions} templates={templates} transformations={transformations} restConnectors={restConnectors} perms={{ manage: can(viewer, "integration.manage"), admin: can(viewer, "integration.admin"), create: can(viewer, "integration.create") }} />
    </div>
  );
}
