import { PageHeader } from "@eaop/design-system";
import { ModelsView } from "@/components/ai-ops/models";
import { Forbidden } from "@/components/forbidden";
import { ops } from "@/lib/ai-operations";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Models" };

export default async function ModelsPage() {
  const viewer = await requireViewer();
  if (!can(viewer, "ai_ops.cost.read")) return <Forbidden permission="ai_ops.cost.read" />;
  const svc = ops(await getPlatform());
  const [report, policies] = [await svc.modelReport(viewer.ctx), await svc.listPolicies(viewer.ctx)];
  return (
    <div className="space-y-6">
      <PageHeader title="Models" description="Model spend and the business policies that decide which model each task may use. The shared AI provider layer performs execution." />
      <ModelsView report={report} policies={policies} canAdmin={can(viewer, "ai_ops.admin")} />
    </div>
  );
}
