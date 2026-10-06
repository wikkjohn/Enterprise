import { PageHeader } from "@eaop/design-system";
import { DocumentList } from "@/components/knowledge/documents";
import { kv } from "@/lib/knowledge";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Documents" };

export default async function DocumentsPage({ searchParams }: { searchParams: Promise<{ sourceId?: string }> }) {
  const sp = await searchParams;
  const viewer = await requireViewer();
  const svc = kv(await getPlatform());
  const [docs, sources] = [await svc.listDocuments(viewer.ctx), await svc.listSources(viewer.ctx)];
  const manage = can(viewer, "knowledge.manage");
  return (
    <div className="space-y-6">
      <PageHeader title="Documents" description={manage ? "All documents in the knowledge layer (you manage knowledge, so restricted ones are listed too)." : "Documents you are permitted to read."} />
      <DocumentList docs={docs} sources={sources.filter((s) => s.status === "active").map((s) => ({ id: s.id, name: s.name, kind: s.kind }))} canIngest={can(viewer, "knowledge.ingest")} initialSource={sp.sourceId} />
    </div>
  );
}
