import { notFound } from "next/navigation";
import { Badge, Breadcrumbs, PageHeader } from "@eaop/design-system";
import { isAppError } from "@eaop/shared-types";
import { SampleBanner } from "@/components/workflow/common";
import { WorkflowDetailView } from "@/components/workflow/detail";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";
import { WI_BASE, wi } from "@/lib/workflow";

export const metadata = { title: "Workflow" };

export default async function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireViewer();
  const svc = wi(await getPlatform());
  const [detail, versions] = await Promise.all([svc.get(viewer.ctx, id), svc.listVersions(viewer.ctx, id)]).catch((e: unknown) => {
    if (isAppError(e, "NOT_FOUND")) notFound();
    throw e;
  });
  const w = detail.workflow;
  const suffix = w.dataClass === "sample" ? "?data=sample" : "";
  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={<Breadcrumbs items={[{ label: "Inventory", href: `${WI_BASE}/workflows${suffix}` }, { label: w.name }]} />}
        title={w.name}
        description={w.description || undefined}
        meta={<span className="flex gap-1">{w.dataClass === "sample" && <Badge tone="warning">Sample</Badge>}<Badge>v{w.currentVersion}</Badge></span>}
      />
      {w.dataClass === "sample" && <SampleBanner />}
      <WorkflowDetailView
        detail={detail}
        versions={versions}
        perms={{
          update: can(viewer, "workflow.update"),
          delete: can(viewer, "workflow.delete"),
          analyze: can(viewer, "workflow.analyze"),
          approve: can(viewer, "workflow.approve"),
          roiManage: can(viewer, "workflow.roi.manage"),
          aiUse: can(viewer, "ai.use"),
          aiRunRead: can(viewer, "ai.run.read"),
        }}
      />
    </div>
  );
}
