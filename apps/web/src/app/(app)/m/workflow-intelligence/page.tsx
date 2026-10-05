import { PageHeader } from "@eaop/design-system";
import { DataClassToggle, SampleBanner } from "@/components/workflow/common";
import { WorkflowDashboard } from "@/components/workflow/dashboard";
import { getPlatform } from "@/lib/platform";
import { requireViewer } from "@/lib/viewer";
import { wi } from "@/lib/workflow";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ data?: string }> }) {
  const dataClass = (await searchParams).data === "sample" ? "sample" : "production";
  const viewer = await requireViewer();
  const dashboard = await wi(await getPlatform()).dashboard(viewer.ctx, { dataClass });
  return (
    <div className="space-y-6">
      <PageHeader title="Workflow Intelligence" description="Where AI creates measurable value across the organization — projected and realized." actions={<DataClassToggle value={dataClass} />} />
      {dataClass === "sample" && <SampleBanner />}
      <WorkflowDashboard data={dashboard} />
    </div>
  );
}
