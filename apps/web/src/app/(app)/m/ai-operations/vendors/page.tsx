import { PageHeader } from "@eaop/design-system";
import { VendorList } from "@/components/ai-ops/inventory";
import { ops } from "@/lib/ai-operations";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "AI vendors" };

export default async function VendorsPage() {
  const viewer = await requireViewer();
  const vendors = await ops(await getPlatform()).listVendors(viewer.ctx);
  return (
    <div className="space-y-6">
      <PageHeader title="AI vendors" description="Vendors, their products, contracts, renewals and security and privacy status." />
      <VendorList vendors={vendors} canManage={can(viewer, "ai_ops.vendor.manage")} canCost={can(viewer, "ai_ops.cost.read")} />
    </div>
  );
}
