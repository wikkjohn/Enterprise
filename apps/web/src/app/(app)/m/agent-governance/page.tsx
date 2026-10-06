import { PageHeader } from "@eaop/design-system";
import { AgentDashboard } from "@/components/agents/dashboard";
import { ag } from "@/lib/agent-governance";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Security dashboard" };

export default async function AgentDashboardPage() {
  const viewer = await requireViewer();
  const svc = ag(await getPlatform());
  const dashboard = await svc.dashboard(viewer.ctx);
  const approvals = can(viewer, "agent.approval.review") ? await svc.listApprovals(viewer.ctx, { status: "pending" }) : [];
  return (
    <div className="space-y-6">
      <PageHeader title="AI Agent Governance" description="What agents exist, who owns them, what they can access and do, what needs a human — and the ability to stop any of them now." />
      <AgentDashboard d={dashboard} approvals={approvals.slice(0, 6)} />
    </div>
  );
}
