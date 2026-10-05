import { notFound } from "next/navigation";
import { Breadcrumbs, PageHeader } from "@eaop/design-system";
import { isAppError } from "@eaop/shared-types";
import { ActionDetailView } from "@/components/integration/actions";
import { getPlatform } from "@/lib/platform";
import { IH_BASE, ih } from "@/lib/integration";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Action" };

export default async function ActionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireViewer();
  const { tool, ...action } = await ih(await getPlatform()).getAction(viewer.ctx, id).catch((e: unknown) => {
    if (isAppError(e, "NOT_FOUND")) notFound();
    throw e;
  });
  return (
    <div className="space-y-6">
      <PageHeader breadcrumbs={<Breadcrumbs items={[{ label: "Action catalog", href: `${IH_BASE}/actions` }, { label: action.name }]} />} title={action.name} description={action.description || action.key} />
      <ActionDetailView action={action} tool={tool} canManage={can(viewer, "integration.manage")} />
    </div>
  );
}
