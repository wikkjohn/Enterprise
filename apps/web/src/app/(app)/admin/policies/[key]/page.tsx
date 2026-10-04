import { notFound } from "next/navigation";
import { Breadcrumbs, PageHeader, StatusBadge } from "@eaop/design-system";
import { PolicyDetail } from "@/components/admin/policies";
import { Forbidden } from "@/components/forbidden";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export default async function Page({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const viewer = await requireViewer();
  if (!can(viewer, "policy.read")) return <Forbidden permission="policy.read" />;
  const policy = await (await getPlatform()).policies.get(viewer.ctx, decodeURIComponent(key)).catch(() => null);
  if (!policy) notFound();
  return (
    <div className="space-y-6">
      <PageHeader title={policy.name} description={policy.description || policy.key} meta={<StatusBadge status={policy.status} />} breadcrumbs={<Breadcrumbs items={[{ label: "Policies", href: "/admin/policies" }, { label: policy.name }]} />} />
      <PolicyDetail policy={policy} canManage={can(viewer, "policy.manage")} />
    </div>
  );
}
