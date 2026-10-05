import { PageHeader } from "@eaop/design-system";
import { Forbidden } from "@/components/forbidden";
import { ExecutionList } from "@/components/integration/history";
import { getPlatform } from "@/lib/platform";
import { ih } from "@/lib/integration";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Executions" };

export default async function ExecutionsPage() {
  const viewer = await requireViewer();
  if (!can(viewer, "integration.history.read")) return <Forbidden permission="integration.history.read" />;
  const svc = ih(await getPlatform());
  const [page, errors] = await Promise.all([svc.listExecutions(viewer.ctx, { limit: 50 }), svc.listErrors(viewer.ctx, { status: "dead_letter" })]);
  return (
    <div className="space-y-6">
      <PageHeader title="Execution history" description="Every workflow run and AI tool call: trigger, input, steps, system and AI calls, approvals, errors, retries, result, duration and cost." />
      <ExecutionList initial={page.data} nextCursor={page.nextCursor ?? null} errors={errors} canManage={can(viewer, "integration.manage")} />
    </div>
  );
}
