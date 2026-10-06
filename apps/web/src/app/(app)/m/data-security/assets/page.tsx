import { PageHeader } from "@eaop/design-system";
import { AssetInventory } from "@/components/data-security/assets";
import { ds } from "@/lib/data-security";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Data assets" };

export default async function AssetsPage({ searchParams }: { searchParams: Promise<{ classification?: string; exposure?: string }> }) {
  const sp = await searchParams;
  const viewer = await requireViewer();
  const platform = await getPlatform();
  const svc = ds(platform);
  const assets = await svc.listAssets(viewer.ctx);
  const scans = await svc.listScans(viewer.ctx);
  const canScan = can(viewer, "data_security.scan");
  const connectors = canScan && can(viewer, "connector.read") ? (await platform.connectors.list(viewer.ctx)).map((c) => ({ id: c.id, name: c.name, type: c.type })) : [];
  return (
    <div className="space-y-6">
      <PageHeader title="Data assets" description="Everything discovered through shared connectors or pushed through the ingestion API: classification, sharing, owner and AI exposure." />
      <AssetInventory assets={assets} scans={scans} connectors={connectors} initial={{ classification: sp.classification, exposure: sp.exposure }} canScan={canScan} />
    </div>
  );
}
