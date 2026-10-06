import { notFound } from "next/navigation";
import { Breadcrumbs, PageHeader } from "@eaop/design-system";
import { isAppError } from "@eaop/shared-types";
import { AssetDetailView } from "@/components/data-security/assets";
import { DS_BASE, ds } from "@/lib/data-security";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Asset" };

export default async function AssetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireViewer();
  const a = await ds(await getPlatform()).getAsset(viewer.ctx, id).catch((e: unknown) => {
    if (isAppError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  });
  return (
    <div className="space-y-6">
      <PageHeader title={a.name} description={a.location || a.sourceSystem} breadcrumbs={<Breadcrumbs items={[{ label: "Data assets", href: `${DS_BASE}/assets` }, { label: a.name }]} />} />
      <AssetDetailView a={a} canClassify={can(viewer, "data_security.classification.manage")} canRemediate={can(viewer, "data_security.remediation.manage")} />
    </div>
  );
}
