import { PageHeader } from "@eaop/design-system";
import { AgentInventory } from "@/components/agents/inventory";
import { ag } from "@/lib/agent-governance";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Agents" };

export default async function AgentsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const viewer = await requireViewer();
  const platform = await getPlatform();
  const agents = await ag(platform).listAgents(viewer.ctx);
  const members = can(viewer, "user.read") ? (await platform.organizations.listMembers(viewer.ctx, { status: "active" })).map((m) => ({ userId: m.userId, name: m.name, email: m.email })) : [{ userId: viewer.user.id, name: viewer.user.name, email: viewer.user.email }];
  return (
    <div className="space-y-6">
      <PageHeader title="Agent inventory" description="Every AI agent known to the organization — registered, or discovered on the Integration tool gateway." />
      <AgentInventory agents={agents} initialStatus={status} canRegister={can(viewer, "agent.register")} members={members} />
    </div>
  );
}
