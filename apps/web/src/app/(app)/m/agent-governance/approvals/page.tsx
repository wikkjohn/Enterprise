import { PageHeader } from "@eaop/design-system";
import { AgentApprovalQueue } from "@/components/agents/governance";
import { Forbidden } from "@/components/forbidden";
import { ag } from "@/lib/agent-governance";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Approvals" };

export default async function AgentApprovalsPage({ searchParams }: { searchParams: Promise<{ focus?: string }> }) {
  const { focus } = await searchParams;
  const viewer = await requireViewer();
  if (!can(viewer, "agent.approval.review")) return <Forbidden permission="agent.approval.review" />;
  const approvals = await ag(await getPlatform()).listApprovals(viewer.ctx);
  return (
    <div className="space-y-6">
      <PageHeader title="Agent approvals" description="Actions agents asked to take that bindings or policies sent to a person. Approve, reject, ask the agent a question, or escalate. The user an agent acts for never decides its request." />
      <AgentApprovalQueue approvals={approvals} focus={focus} canManage={can(viewer, "agent.manage")} />
    </div>
  );
}
