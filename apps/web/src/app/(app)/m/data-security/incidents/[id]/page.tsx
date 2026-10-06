import { notFound } from "next/navigation";
import { Breadcrumbs, PageHeader } from "@eaop/design-system";
import { isAppError } from "@eaop/shared-types";
import { IncidentDetailView } from "@/components/data-security/incidents";
import { Forbidden } from "@/components/forbidden";
import { DS_BASE, ds } from "@/lib/data-security";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Incident" };

export default async function IncidentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireViewer();
  if (!can(viewer, "data_security.incident.read")) return <Forbidden permission="data_security.incident.read" />;
  const platform = await getPlatform();
  const i = await ds(platform).getIncident(viewer.ctx, id).catch((e: unknown) => {
    if (isAppError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  });
  const members = can(viewer, "user.read") ? (await platform.organizations.listMembers(viewer.ctx, { status: "active" })).map((m) => ({ userId: m.userId, name: m.name })) : [{ userId: viewer.user.id, name: viewer.user.name }];
  return (
    <div className="space-y-6">
      <PageHeader title={i.title} description={i.description} breadcrumbs={<Breadcrumbs items={[{ label: "Incidents", href: `${DS_BASE}/incidents` }, { label: i.title }]} />} />
      <IncidentDetailView i={i} canManage={can(viewer, "data_security.incident.manage")} canRemediate={can(viewer, "data_security.remediation.manage")} members={members} />
    </div>
  );
}
