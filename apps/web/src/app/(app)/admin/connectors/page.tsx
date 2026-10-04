import { PageHeader } from "@eaop/design-system";
import { ConnectorsList, type CatalogEntry } from "@/components/admin/connectors";
import { Forbidden } from "@/components/forbidden";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Connectors" };

export default async function ConnectorsPage() {
  const viewer = await requireViewer();
  if (!can(viewer, "connector.read")) return <Forbidden permission="connector.read" />;
  const platform = await getPlatform();
  const connectors = await platform.connectors.list(viewer.ctx);
  const catalog = JSON.parse(JSON.stringify(platform.connectors.catalog())) as CatalogEntry[];
  return (
    <div className="space-y-6">
      <PageHeader title="Connectors" description="Connections to enterprise systems, configured once and shared by every module." />
      <ConnectorsList connectors={connectors} catalog={catalog} canManage={can(viewer, "connector.manage")} />
    </div>
  );
}
