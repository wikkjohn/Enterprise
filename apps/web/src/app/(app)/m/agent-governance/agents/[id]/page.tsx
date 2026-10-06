import { notFound } from "next/navigation";
import { Breadcrumbs, PageHeader } from "@eaop/design-system";
import { isAppError } from "@eaop/shared-types";
import { AgentDetailView } from "@/components/agents/detail";
import { AG_BASE, ag } from "@/lib/agent-governance";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Agent" };

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireViewer();
  const platform = await getPlatform();
  const agent = await ag(platform).getAgent(viewer.ctx, id).catch((e: unknown) => {
    if (isAppError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  });
  const connectors = can(viewer, "connector.read") ? (await platform.connectors.list(viewer.ctx)).map((c) => ({ id: c.id, name: c.name, type: c.type })) : [];
  const members = can(viewer, "user.read") ? (await platform.organizations.listMembers(viewer.ctx, { status: "active" })).map((m) => ({ userId: m.userId, name: m.name, email: m.email })) : [];
  return (
    <div className="space-y-6">
      <PageHeader title={agent.name} description={agent.businessPurpose || agent.description || "No business purpose recorded."} breadcrumbs={<Breadcrumbs items={[{ label: "Agents", href: `${AG_BASE}/agents` }, { label: agent.name }]} />} />
      <AgentDetailView
        agent={agent} connectors={connectors} members={members} viewerId={viewer.user.id}
        perms={{ manage: can(viewer, "agent.manage"), suspend: can(viewer, "agent.suspend"), policyManage: can(viewer, "agent.policy.manage"), policyRead: can(viewer, "agent.policy.read"), incident: can(viewer, "agent.incident.manage"), audit: can(viewer, "agent.audit.read") }}
      />
    </div>
  );
}
