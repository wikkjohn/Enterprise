import { PageHeader } from "@eaop/design-system";
import { ApprovalQueue } from "@/components/integration/history";
import { getPlatform } from "@/lib/platform";
import { ih } from "@/lib/integration";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Approvals" };

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<{ focus?: string }> }) {
  const { focus } = await searchParams;
  const viewer = await requireViewer();
  const approvals = await ih(await getPlatform()).listApprovals(viewer.ctx);
  return (
    <div className="space-y-6">
      <PageHeader title="Approvals" description="Actions paused by policy or configuration until a person decides. Approvers never approve their own executions." />
      <ApprovalQueue approvals={approvals} focus={focus} viewerId={viewer.user.id} canApprove={can(viewer, "integration.approve")} canHistory={can(viewer, "integration.history.read")} />
    </div>
  );
}
