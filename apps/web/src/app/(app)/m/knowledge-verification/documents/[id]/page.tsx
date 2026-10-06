import { notFound } from "next/navigation";
import { Breadcrumbs, PageHeader } from "@eaop/design-system";
import { isAppError } from "@eaop/shared-types";
import { DocumentDetailView } from "@/components/knowledge/documents";
import { KV_BASE, kv } from "@/lib/knowledge";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Document" };

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireViewer();
  const platform = await getPlatform();
  const d = await kv(platform).getDocument(viewer.ctx, id).catch((e: unknown) => {
    if (isAppError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  });
  const canManage = can(viewer, "knowledge.manage");
  const members = canManage && can(viewer, "user.read") ? (await platform.organizations.listMembers(viewer.ctx, { status: "active" })).map((m) => ({ userId: m.userId, name: m.name })) : [];
  return (
    <div className="space-y-6">
      <PageHeader title={d.title} breadcrumbs={<Breadcrumbs items={[{ label: "Documents", href: `${KV_BASE}/documents` }, { label: d.title }]} />} />
      <DocumentDetailView d={d} canManage={canManage} canSetAccess={can(viewer, "knowledge.source.manage")} members={members} />
    </div>
  );
}
