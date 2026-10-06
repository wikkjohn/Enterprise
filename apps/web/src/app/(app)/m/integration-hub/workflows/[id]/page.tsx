import { notFound } from "next/navigation";
import { Breadcrumbs, PageHeader } from "@eaop/design-system";
import { isAppError } from "@eaop/shared-types";
import { WorkflowEditor } from "@/components/integration/editor";
import { getPlatform } from "@/lib/platform";
import { IH_BASE, ih } from "@/lib/integration";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Workflow" };

export default async function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireViewer();
  const platform = await getPlatform();
  const svc = ih(platform);
  const [workflow, actions] = await Promise.all([svc.getWorkflow(viewer.ctx, id), svc.listActions(viewer.ctx)]).catch((e: unknown) => {
    if (isAppError(e, "NOT_FOUND")) notFound();
    throw e;
  });
  const eventTypes = platform.events.registry.list().map((e) => e.type).filter((t) => !t.startsWith("integration.")).sort();
  return (
    <div className="space-y-6">
      <PageHeader breadcrumbs={<Breadcrumbs items={[{ label: "Workflows", href: `${IH_BASE}/workflows` }, { label: workflow.name }]} />} title={workflow.name} description={workflow.description || undefined} />
      <WorkflowEditor
        key={workflow.currentVersion}
        workflow={workflow}
        actions={actions}
        eventTypes={eventTypes}
        perms={{ create: can(viewer, "integration.create"), manage: can(viewer, "integration.manage"), execute: can(viewer, "integration.execute"), history: can(viewer, "integration.history.read") }}
      />
    </div>
  );
}
