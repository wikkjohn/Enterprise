import { notFound } from "next/navigation";
import { Breadcrumbs, PageHeader } from "@eaop/design-system";
import { isAppError } from "@eaop/shared-types";
import { VendorDetailView } from "@/components/ai-ops/inventory";
import { OPS_BASE, ops } from "@/lib/ai-operations";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "AI vendor" };

export default async function VendorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireViewer();
  const platform = await getPlatform();
  const v = await ops(platform).getVendor(viewer.ctx, id).catch((e: unknown) => {
    if (isAppError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  });
  const canManage = can(viewer, "ai_ops.vendor.manage");
  const members = canManage && can(viewer, "user.read") ? (await platform.organizations.listMembers(viewer.ctx, { status: "active" })).map((m) => ({ userId: m.userId, name: m.name })) : [];
  return (
    <div className="space-y-6">
      <PageHeader title={v.name} breadcrumbs={<Breadcrumbs items={[{ label: "AI vendors", href: `${OPS_BASE}/vendors` }, { label: v.name }]} />} />
      <VendorDetailView v={v} members={members} canManage={canManage} />
    </div>
  );
}
