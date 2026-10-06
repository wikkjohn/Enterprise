import { notFound } from "next/navigation";
import { Breadcrumbs, PageHeader } from "@eaop/design-system";
import { isAppError } from "@eaop/shared-types";
import { ToolDetailView } from "@/components/ai-ops/inventory";
import { OPS_BASE, ops } from "@/lib/ai-operations";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "AI tool" };

export default async function ToolPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireViewer();
  const platform = await getPlatform();
  const svc = ops(platform);
  const t = await svc.getTool(viewer.ctx, id).catch((e: unknown) => {
    if (isAppError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  });
  const canManage = can(viewer, "ai_ops.tool.manage");
  const vendors = canManage ? (await svc.listVendors(viewer.ctx)).map((v) => ({ id: v.id, name: v.name })) : [];
  const members = canManage && can(viewer, "user.read") ? (await platform.organizations.listMembers(viewer.ctx, { status: "active" })).map((m) => ({ userId: m.userId, name: m.name })) : [];
  return (
    <div className="space-y-6">
      <PageHeader title={t.name} breadcrumbs={<Breadcrumbs items={[{ label: "AI tools", href: `${OPS_BASE}/tools` }, { label: t.name }]} />} />
      <ToolDetailView t={t} vendors={vendors} members={members} canManage={canManage} />
    </div>
  );
}
