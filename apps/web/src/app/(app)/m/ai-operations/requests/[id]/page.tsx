import { notFound } from "next/navigation";
import { Breadcrumbs, PageHeader } from "@eaop/design-system";
import { isAppError } from "@eaop/shared-types";
import { RequestDetailView } from "@/components/ai-ops/requests";
import { OPS_BASE, ops } from "@/lib/ai-operations";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "AI request" };

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireViewer();
  const platform = await getPlatform();
  const r = await ops(platform).getRequest(viewer.ctx, id).catch((e: unknown) => {
    if (isAppError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  });
  const members = r.can.startReview && can(viewer, "user.read") ? (await platform.organizations.listMembers(viewer.ctx, { status: "active" })).map((m) => ({ userId: m.userId, name: m.name })) : [];
  return (
    <div className="space-y-6">
      <PageHeader title={r.title} breadcrumbs={<Breadcrumbs items={[{ label: "AI requests", href: `${OPS_BASE}/requests` }, { label: r.title }]} />} />
      <RequestDetailView r={r} members={members} />
    </div>
  );
}
