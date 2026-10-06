import { notFound } from "next/navigation";
import { Breadcrumbs, PageHeader } from "@eaop/design-system";
import { isAppError } from "@eaop/shared-types";
import { ToolDetailView } from "@/components/data-security/shadow";
import { Forbidden } from "@/components/forbidden";
import { DS_BASE, ds } from "@/lib/data-security";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "AI tool" };

export default async function ToolPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireViewer();
  if (!can(viewer, "data_security.shadow_ai.read")) return <Forbidden permission="data_security.shadow_ai.read" />;
  const t = await ds(await getPlatform()).getTool(viewer.ctx, id).catch((e: unknown) => {
    if (isAppError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  });
  return (
    <div className="space-y-6">
      <PageHeader title={`${t.vendor}${t.name !== t.vendor ? ` ${t.name}` : ""}`} breadcrumbs={<Breadcrumbs items={[{ label: "Shadow AI", href: `${DS_BASE}/shadow-ai` }, { label: t.name }]} />} />
      <ToolDetailView t={t} canManage={can(viewer, "data_security.policy.manage")} />
    </div>
  );
}
