import { Breadcrumbs, PageHeader } from "@eaop/design-system";
import { ConnectorDetail, type CatalogEntry } from "@/components/admin/connectors";
import { Forbidden } from "@/components/forbidden";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";
import { notFound } from "next/navigation";

export default async function ConnectorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireViewer();
  if (!can(viewer, "connector.read")) return <Forbidden permission="connector.read" />;
  const platform = await getPlatform();
  const connector = await platform.connectors.get(viewer.ctx, id).catch(() => null);
  if (!connector) notFound();
  const def = JSON.parse(JSON.stringify(platform.connectors.catalog().find((d) => d.type === connector.type) ?? null)) as CatalogEntry | null;
  return (
    <div className="space-y-6">
      <PageHeader title={connector.name} description={connector.description ?? undefined} breadcrumbs={<Breadcrumbs items={[{ label: "Connectors", href: "/admin/connectors" }, { label: connector.name }]} />} />
      <ConnectorDetail connector={connector} def={def ?? undefined} canManage={can(viewer, "connector.manage")} canManageCreds={can(viewer, "connector.credential.manage")} />
    </div>
  );
}
