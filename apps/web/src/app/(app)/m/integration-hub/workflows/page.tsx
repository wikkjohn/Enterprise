import { PageHeader } from "@eaop/design-system";
import { WorkflowList } from "@/components/integration/workflows";
import { getPlatform } from "@/lib/platform";
import { ih } from "@/lib/integration";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Workflows" };

export default async function WorkflowsPage() {
  const viewer = await requireViewer();
  const platform = await getPlatform();
  const workflows = await ih(platform).listWorkflows(viewer.ctx);
  const eventTypes = platform.events.registry.list().map((e) => e.type).filter((t) => !t.startsWith("integration.")).sort();
  return (
    <div className="space-y-6">
      <PageHeader title="Workflows" description="Multi-system business workflows that run under enterprise controls: validation, permissions, policy, approval, retries and full history." />
      <WorkflowList workflows={workflows} canCreate={can(viewer, "integration.create")} canManage={can(viewer, "integration.manage")} eventTypes={eventTypes} />
    </div>
  );
}
