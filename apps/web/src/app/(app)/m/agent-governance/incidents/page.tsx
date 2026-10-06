import { PageHeader } from "@eaop/design-system";
import { IncidentList } from "@/components/agents/governance";
import { ag } from "@/lib/agent-governance";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Incidents" };

export default async function IncidentsPage({ searchParams }: { searchParams: Promise<{ focus?: string }> }) {
  const { focus } = await searchParams;
  const viewer = await requireViewer();
  const incidents = await ag(await getPlatform()).listIncidents(viewer.ctx);
  return (
    <div className="space-y-6">
      <PageHeader title="Agent incidents" description="Opened automatically by every kill-switch action, or manually. Investigate, replay the surrounding activity and resolve." />
      <IncidentList incidents={incidents} focus={focus} canManage={can(viewer, "agent.incident.manage")} canAudit={can(viewer, "agent.audit.read")} />
    </div>
  );
}
