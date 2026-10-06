import { PageHeader } from "@eaop/design-system";
import { SourceList } from "@/components/knowledge/sources";
import { kv } from "@/lib/knowledge";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Sources" };

export default async function SourcesPage() {
  const viewer = await requireViewer();
  const platform = await getPlatform();
  const sources = await kv(platform).listSources(viewer.ctx);
  const canManage = can(viewer, "knowledge.source.manage");
  const connectors = canManage && can(viewer, "connector.read") ? (await platform.connectors.list(viewer.ctx)).map((c) => ({ id: c.id, name: c.name, type: c.type })) : [];
  const members = canManage && can(viewer, "user.read") ? (await platform.organizations.listMembers(viewer.ctx, { status: "active" })).map((m) => ({ userId: m.userId, name: m.name })) : [];
  return (
    <div className="space-y-6">
      <PageHeader title="Sources" description="Where knowledge comes from, how authoritative it is, and who may read it by default." />
      <SourceList sources={sources} connectors={connectors} members={members} canManage={canManage} canIngest={can(viewer, "knowledge.ingest")} />
    </div>
  );
}
