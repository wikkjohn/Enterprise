import { PageHeader } from "@eaop/design-system";
import { ReplayBrowser, type ReplayFilters } from "@/components/agents/governance";
import { Forbidden } from "@/components/forbidden";
import { ag } from "@/lib/agent-governance";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Activity & replay" };

export default async function ActivityPage({ searchParams }: { searchParams: Promise<ReplayFilters> }) {
  const raw = await searchParams;
  const filters: ReplayFilters = Object.fromEntries(Object.entries(raw).filter(([k, v]) => typeof v === "string" && v.length <= 200 && ["agentId", "userId", "system", "action", "decision", "from", "to", "incidentId"].includes(k)));
  const viewer = await requireViewer();
  if (!can(viewer, "agent.audit.read")) return <Forbidden permission="agent.audit.read" />;
  const platform = await getPlatform();
  const svc = ag(platform);
  const sessions = await svc.listSessions(viewer.ctx, { ...filters, to: filters.to ? `${filters.to}T23:59:59Z` : undefined });
  const agents = (await svc.listAgents(viewer.ctx)).map((a) => ({ id: a.id, name: a.name }));
  const incidents = (await svc.listIncidents(viewer.ctx)).slice(0, 100).map((i) => ({ id: i.id, title: `${i.agentName}: ${i.title}` }));
  const users = can(viewer, "user.read") ? (await platform.organizations.listMembers(viewer.ctx)).map((m) => ({ userId: m.userId, name: m.name })) : [];
  const activity = await svc.listActivity(viewer.ctx, { agentId: filters.agentId, decision: filters.decision, limit: 50 });
  return (
    <div className="space-y-6">
      <PageHeader title="Activity & audit replay" description="Instructions, tool calls, proposed actions, policy decisions, approvals, executions, errors and outputs — filtered and replayable. Content follows your organization's AI retention setting." />
      <ReplayBrowser sessions={sessions} filters={filters} agents={agents} users={users} incidents={incidents} activity={activity} />
    </div>
  );
}
