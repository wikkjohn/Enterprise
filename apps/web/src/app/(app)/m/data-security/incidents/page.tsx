import { PageHeader } from "@eaop/design-system";
import { IncidentList } from "@/components/data-security/incidents";
import { Forbidden } from "@/components/forbidden";
import { ds } from "@/lib/data-security";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Incidents" };

export default async function IncidentsPage() {
  const viewer = await requireViewer();
  if (!can(viewer, "data_security.incident.read")) return <Forbidden permission="data_security.incident.read" />;
  const incidents = await ds(await getPlatform()).listIncidents(viewer.ctx);
  return (
    <div className="space-y-6">
      <PageHeader title="Security incidents" description="Opened automatically for credential exposure, sensitive data to unapproved AI, large AI-bound exports, restricted data, abnormal AI activity and policy violations — or by hand." />
      <IncidentList incidents={incidents} canManage={can(viewer, "data_security.incident.manage")} />
    </div>
  );
}
