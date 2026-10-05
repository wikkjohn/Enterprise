import { notFound } from "next/navigation";
import { Badge, Breadcrumbs, PageHeader } from "@eaop/design-system";
import { isAppError } from "@eaop/shared-types";
import { SampleBanner } from "@/components/workflow/common";
import { ImplementationDetailView } from "@/components/workflow/implementations";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";
import { WI_BASE, wi } from "@/lib/workflow";

export const metadata = { title: "Implementation" };

export default async function ImplementationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireViewer();
  const impl = await wi(await getPlatform()).getImplementation(viewer.ctx, id).catch((e: unknown) => {
    if (isAppError(e, "NOT_FOUND")) notFound();
    throw e;
  });
  const suffix = impl.dataClass === "sample" ? "?data=sample" : "";
  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={<Breadcrumbs items={[{ label: "Implementations", href: `${WI_BASE}/implementations${suffix}` }, { label: impl.workflowName }]} />}
        title={impl.workflowName}
        description="Implementation tracking, baseline and realized ROI."
        meta={<span className="flex gap-1">{impl.dataClass === "sample" && <Badge tone="warning">Sample</Badge>}<Badge tone="accent">{impl.stage}</Badge></span>}
      />
      {impl.dataClass === "sample" && <SampleBanner />}
      <ImplementationDetailView impl={impl} perms={{ manage: can(viewer, "workflow.implementation.manage"), roiManage: can(viewer, "workflow.roi.manage") }} />
    </div>
  );
}
