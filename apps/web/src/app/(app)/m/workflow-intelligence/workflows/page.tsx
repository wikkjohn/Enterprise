import { PageHeader } from "@eaop/design-system";
import { DataClassToggle, SampleBanner } from "@/components/workflow/common";
import { WorkflowInventory } from "@/components/workflow/inventory";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";
import { wi } from "@/lib/workflow";

export const metadata = { title: "Inventory" };

export default async function InventoryPage({ searchParams }: { searchParams: Promise<{ data?: string }> }) {
  const dataClass = (await searchParams).data === "sample" ? "sample" : "production";
  const viewer = await requireViewer();
  const platform = await getPlatform();
  const workflows = await wi(platform).list(viewer.ctx, { dataClass });
  const connectors = can(viewer, "connector.use") && can(viewer, "connector.read")
    ? (await platform.connectors.list(viewer.ctx)).filter((c) => c.status !== "disabled").map((c) => ({ id: c.id, name: c.name, type: c.type, capabilities: c.capabilities }))
    : [];
  return (
    <div className="space-y-6">
      <PageHeader title="Workflow inventory" description="Every business workflow under review — its owners, volume, systems, risk and analysis status." actions={<DataClassToggle value={dataClass} />} />
      {dataClass === "sample" && <SampleBanner />}
      <WorkflowInventory
        workflows={workflows}
        dataClass={dataClass}
        connectors={connectors}
        canCreate={can(viewer, "workflow.create")}
        canDelete={can(viewer, "workflow.delete")}
      />
    </div>
  );
}
