import { notFound } from "next/navigation";
import { Breadcrumbs, PageHeader } from "@eaop/design-system";
import { isAppError } from "@eaop/shared-types";
import { Forbidden } from "@/components/forbidden";
import { ExecutionDetailView } from "@/components/integration/history";
import { getPlatform } from "@/lib/platform";
import { IH_BASE, ih } from "@/lib/integration";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Execution" };

export default async function ExecutionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireViewer();
  if (!can(viewer, "integration.history.read")) return <Forbidden permission="integration.history.read" />;
  const execution = await ih(await getPlatform()).getExecution(viewer.ctx, id).catch((e: unknown) => {
    if (isAppError(e, "NOT_FOUND")) notFound();
    throw e;
  });
  return (
    <div className="space-y-6">
      <PageHeader breadcrumbs={<Breadcrumbs items={[{ label: "Executions", href: `${IH_BASE}/executions` }, { label: execution.id.slice(0, 8) }]} />} title={execution.workflowName ?? `Tool call: ${execution.actionKey}`} description={`Execution ${execution.id}`} />
      <ExecutionDetailView execution={execution} perms={{ manage: can(viewer, "integration.manage"), execute: can(viewer, "integration.execute"), viewerId: viewer.user.id }} />
    </div>
  );
}
